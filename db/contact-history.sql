-- Sky Blue CRM — one contact history per person
--
-- Run once in the Supabase SQL editor. Safe to re-run.
-- Run AFTER db/lead-contact.sql.
--
-- THE PROBLEM
--
-- A person exists twice: as a lead while you're chasing them, and as a
-- customer once they book. Nothing in the schema connects the two rows.
-- `customers` has no lead_id; the only threads are the jobs row (which
-- carries both ids) and findOrCreateCustomer matching on phone digits.
--
-- So "ring Nick, see everything we've ever done with Nick" had no answer.
-- Calls landed in lead_events, which dies with the lead and is invisible
-- from the customer profile.
--
-- THE APPROACH
--
-- One log, three ways to identify who a row belongs to: the lead id, the
-- customer id, and the normalised phone. Every write stamps whichever it
-- can resolve. Reading follows all three, so the thread survives:
--
--   * a lead becoming a customer (both ids get stamped from then on)
--   * a customer with no originating lead (walk-in, referral)
--   * a lead whose customer was created before this migration (phone)
--   * someone changing their number (the ids still match)
--
-- No single one of those is reliable on its own. Together they are.

-- ---------------------------------------------------------------------------
-- 1. Phone digits, the same way the app does it
-- ---------------------------------------------------------------------------

-- normalizePhone in jobService.js is `(phone || "").replace(/\D/g, "")`.
-- This has to agree with it exactly, or a customer found by the app won't be
-- found by the timeline.
create or replace function public.sb_phone_digits(p text)
returns text
language sql
immutable
as $$ select nullif(regexp_replace(coalesce(p, ''), '\D', '', 'g'), '') $$;

comment on function public.sb_phone_digits(text) is
  'Digits only, matching normalizePhone() in jobService.js. Null for empty.';

-- ---------------------------------------------------------------------------
-- 2. Customers get the same outreach columns leads have
-- ---------------------------------------------------------------------------

alter table public.customers
  add column if not exists last_contacted_at timestamptz,
  add column if not exists contact_attempts  int not null default 0;

-- ---------------------------------------------------------------------------
-- 3. The log
-- ---------------------------------------------------------------------------

create table if not exists public.contact_log (
  id          bigint generated always as identity primary key,
  -- Both nullable, both stamped when known. A row with only a phone still
  -- finds its way home.
  lead_id     uuid references public.leads (id)     on delete set null,
  customer_id uuid references public.customers (id) on delete set null,
  phone_norm  text,
  -- call | text | email | note. Text, not an enum, so adding a channel is
  -- app-side only — same reasoning as lead_events.kind.
  kind        text not null default 'call',
  -- When a call advanced the lead (new -> contacted), the move is recorded
  -- here rather than left to lead_events. Otherwise the timeline has to
  -- either drop the transition or show the call twice — once as outreach
  -- and once as a status change a second apart.
  from_status text,
  to_status   text,
  detail      text,
  changed_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now()
);

-- on delete set null rather than cascade, deliberately: deleting a test lead
-- shouldn't erase the record that you rang that person. The phone keeps it
-- attached to whoever they are now.

-- For a database that ran an earlier version of this file.
alter table public.contact_log
  add column if not exists from_status text,
  add column if not exists to_status   text;

create index if not exists contact_log_lead_idx     on public.contact_log (lead_id, created_at);
create index if not exists contact_log_customer_idx on public.contact_log (customer_id, created_at);
create index if not exists contact_log_phone_idx    on public.contact_log (phone_norm, created_at);

comment on table public.contact_log is
  'Every time we reached out to someone, whether they were a lead or a
   customer at the time. Read through contact_timeline().';

alter table public.contact_log enable row level security;

drop policy if exists "contact_log readable by authenticated" on public.contact_log;
create policy "contact_log readable by authenticated"
  on public.contact_log for select to authenticated using (true);

-- No insert policy: writes go through record_contact() below, which is
-- security definer. Same append-only shape as lead_events and job_events.

-- ---------------------------------------------------------------------------
-- 4. Who is this person?
-- ---------------------------------------------------------------------------

-- Given either id, return every lead id, every customer id and the phone
-- that belong to the same human. A person can have several leads (knocked
-- twice, called back months later) that all became one customer, so these
-- are arrays rather than single ids.
create or replace function public.contact_identity(
  p_lead_id     uuid default null,
  p_customer_id uuid default null
)
returns table (lead_ids uuid[], customer_ids uuid[], phone text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  ph    text;
  leads_out     uuid[] := '{}';
  customers_out uuid[] := '{}';
begin
  -- Start from whichever id we were handed and find its phone.
  select sb_phone_digits(l.phone) into ph from public.leads l where l.id = p_lead_id;
  if ph is null then
    select sb_phone_digits(c.phone) into ph from public.customers c where c.id = p_customer_id;
  end if;

  -- Leads: the one we were given, anything sharing the phone, and anything
  -- joined to the customer through a job.
  select coalesce(array_agg(distinct id), '{}') into leads_out
  from (
    select l.id from public.leads l where l.id = p_lead_id
    union
    select l.id from public.leads l
      where ph is not null and sb_phone_digits(l.phone) = ph
    union
    select j.lead_id from public.jobs j
      where j.lead_id is not null
        and (j.customer_id = p_customer_id
             or j.lead_id = p_lead_id
             or j.customer_id in (select cc.id from public.customers cc
                                  where ph is not null and sb_phone_digits(cc.phone) = ph))
  ) s;

  -- Customers: the same three routes in reverse.
  select coalesce(array_agg(distinct id), '{}') into customers_out
  from (
    select c.id from public.customers c where c.id = p_customer_id
    union
    select c.id from public.customers c
      where ph is not null and sb_phone_digits(c.phone) = ph
    union
    select j.customer_id from public.jobs j
      where j.customer_id is not null
        and (j.lead_id = p_lead_id or j.lead_id = any(leads_out))
  ) s;

  return query select leads_out, customers_out, ph;
end;
$$;

comment on function public.contact_identity(uuid, uuid) is
  'Every lead id, customer id and the phone belonging to one person.
   Resolved three ways because no single link is reliable on its own.';

-- ---------------------------------------------------------------------------
-- 5. Recording that we reached out
-- ---------------------------------------------------------------------------

create or replace function public.record_contact(
  p_lead_id     uuid default null,
  p_customer_id uuid default null,
  p_kind        text default 'call',
  p_detail      text default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid;
  ident record;
  lead_out uuid;
  cust_out uuid;
  new_id bigint;
  was     text;
  becomes text;
begin
  select p.id into actor from public.profiles p where p.id = auth.uid();

  select * into ident from public.contact_identity(p_lead_id, p_customer_id);

  -- Prefer the id we were handed; fall back to whatever the identity
  -- resolver found, so a call from a customer page still tags the lead it
  -- came from and vice versa.
  lead_out := coalesce(p_lead_id, (select x from unnest(ident.lead_ids) x limit 1));
  cust_out := coalesce(p_customer_id, (select x from unnest(ident.customer_ids) x limit 1));

  -- Read the status before the update below so the move can be recorded.
  if lead_out is not null then
    select status into was from public.leads where id = lead_out;
    becomes := case when was = 'new' then 'contacted' else null end;
  end if;

  insert into public.contact_log (
    lead_id, customer_id, phone_norm, kind, from_status, to_status, detail, changed_by
  )
  values (
    lead_out, cust_out, ident.phone, coalesce(p_kind, 'call'),
    case when becomes is not null then was else null end,
    becomes, p_detail, actor
  )
  returning id into new_id;

  -- Keep the denormalised "last reached out" columns in step. These are what
  -- the follow-up automation will read, and what the lead and customer pages
  -- show without loading the whole timeline.
  if lead_out is not null then
    update public.leads
    set last_contacted_at = now(),
        contact_attempts  = coalesce(contact_attempts, 0) + 1,
        -- Same rule as record_lead_contact: status is a position in the
        -- funnel, so only a lead still on 'new' advances.
        status = case when status = 'new' then 'contacted' else status end
    where id = lead_out;
  end if;

  if cust_out is not null then
    update public.customers
    set last_contacted_at = now(),
        contact_attempts  = coalesce(contact_attempts, 0) + 1
    where id = cust_out;
  end if;

  return new_id;
end;
$$;

grant execute on function public.record_contact(uuid, uuid, text, text) to authenticated;
grant execute on function public.contact_identity(uuid, uuid) to authenticated;

-- record_lead_contact stays, now as a thin wrapper, so nothing that already
-- calls it has to change and there is only one code path doing the work.
create or replace function public.record_lead_contact(p_lead_id uuid)
returns public.leads
language plpgsql
security definer
set search_path = public
as $$
declare
  updated public.leads;
begin
  perform public.record_contact(p_lead_id, null, 'call', null);
  select * into updated from public.leads where id = p_lead_id;

  if updated.id is null then
    raise exception 'No lead with id %', p_lead_id;
  end if;

  return updated;
end;
$$;

grant execute on function public.record_lead_contact(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. The timeline
-- ---------------------------------------------------------------------------

-- Everything that ever happened with this person, oldest first: outreach
-- from contact_log, lead milestones from lead_events, and job milestones
-- from job_events for any job of theirs.
--
-- Returns raw values rather than sentences. The wording lives in the app,
-- the same way SERVICE_PLANS owns plan labels — so changing "Booked" to
-- "Confirmed" is a one-line JS change, not a migration.
create or replace function public.contact_timeline(
  p_lead_id     uuid default null,
  p_customer_id uuid default null
)
returns table (
  at             timestamptz,
  source         text,
  kind           text,
  from_status    text,
  to_status      text,
  amount         numeric,
  payment_method text,
  detail         text,
  actor          text,
  -- Only here so the union can order deterministically; the app ignores it.
  seq            bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  ident record;
begin
  select * into ident from public.contact_identity(p_lead_id, p_customer_id);

  return query
  -- outreach
  select cl.created_at, 'contact'::text, cl.kind,
         cl.from_status, cl.to_status, null::numeric, null::text,
         cl.detail, p.full_name, cl.id
  from public.contact_log cl
  left join public.profiles p on p.id = cl.changed_by
  where cl.lead_id = any(ident.lead_ids)
     or cl.customer_id = any(ident.customer_ids)
     or (ident.phone is not null and cl.phone_norm = ident.phone)

  union all

  -- lead milestones. 'call' rows are excluded: contact_log owns outreach
  -- now, and the backfill below copies the old ones across, so including
  -- both would show every historic call twice.
  select le.created_at, 'lead'::text, le.kind,
         le.from_status, le.to_status, null::numeric, null::text,
         null::text, p.full_name, le.id
  from public.lead_events le
  left join public.profiles p on p.id = le.changed_by
  where le.lead_id = any(ident.lead_ids)
    and coalesce(le.kind, 'status') <> 'call'

  union all

  -- job milestones
  select je.created_at, 'job'::text, je.kind,
         je.from_status, je.to_status, je.amount, je.payment_method,
         je.detail, p.full_name, je.id
  from public.job_events je
  join public.jobs j on j.id = je.job_id
  left join public.profiles p on p.id = je.changed_by
  where j.lead_id = any(ident.lead_ids)
     or j.customer_id = any(ident.customer_ids)

  -- Timestamp, then the source row's own id. A trigger writes several
  -- rows inside one statement, so they share now() to the microsecond and
  -- ordering by time alone put "payment" above "completed".
  order by 1, 10;
end;
$$;

grant execute on function public.contact_timeline(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Backfill the calls already recorded
-- ---------------------------------------------------------------------------

-- db/lead-contact.sql logged calls into lead_events. Move them across so the
-- new timeline is complete rather than starting from today. The originals
-- stay put and are filtered out of the timeline above.
insert into public.contact_log (lead_id, customer_id, phone_norm, kind, detail, changed_by, created_at)
select
  le.lead_id,
  (select j.customer_id from public.jobs j
    where j.lead_id = le.lead_id and j.customer_id is not null limit 1),
  public.sb_phone_digits(l.phone),
  'call',
  'Recorded before the contact history existed',
  le.changed_by,
  le.created_at
from public.lead_events le
join public.leads l on l.id = le.lead_id
where le.kind = 'call'
  and not exists (
    select 1 from public.contact_log c
    where c.lead_id = le.lead_id and c.created_at = le.created_at
  );

-- ---------------------------------------------------------------------------
-- 8. What you've got
-- ---------------------------------------------------------------------------

select
  coalesce(l.name, c.name)          as person,
  count(*)                          as contacts,
  max(cl.created_at)                as last_reached_out
from public.contact_log cl
left join public.leads l     on l.id = cl.lead_id
left join public.customers c on c.id = cl.customer_id
group by coalesce(l.name, c.name)
order by last_reached_out desc nulls last
limit 20;
