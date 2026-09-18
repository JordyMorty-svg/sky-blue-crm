-- db/quote-views.sql
--
-- How many times the customer has opened a quote, and when they last did.
--
-- Run once in the Supabase SQL editor, AFTER db/quotes.sql,
-- db/quote-history.sql and db/quote-preview.sql. Safe to re-run.
--
-- --------------------------------------------------------------------------
-- Why a count is worth a migration
-- --------------------------------------------------------------------------
--
-- `viewed_at` is set with coalesce(viewed_at, now()), so it records the FIRST
-- open and never moves again. A quote opened once and a quote opened nine
-- times are indistinguishable — and they mean opposite things.
--
-- Opened once, days ago: they looked, they moved on. Worth one nudge.
-- Opened five times, twice today: they are talking it over with somebody.
-- That is not a nudge, that is a phone call, and it is the most valuable
-- signal this table can carry.
--
-- The count only means anything because of db/quote-preview.sql. Before that,
-- a rep checking their own link incremented the same number the customer did,
-- and a count polluted by staff is worse than no count — a number gets
-- trusted in a way a boolean does not.

-- --------------------------------------------------------------------------
-- Columns
-- --------------------------------------------------------------------------

alter table public.quotes
  add column if not exists view_count     integer     not null default 0,
  add column if not exists last_viewed_at timestamptz;

-- Backfill what is already known. A quote with a viewed_at was opened at
-- least once, and claiming one open is the honest floor — the real number is
-- unknowable, because nothing was counting.
--
-- Guarded on view_count = 0 so re-running this file never adds a phantom
-- open to a quote that has since been opened for real.
update public.quotes
   set view_count = 1,
       last_viewed_at = viewed_at
 where viewed_at is not null
   and view_count = 0;

comment on column public.quotes.view_count is
  'Times the CUSTOMER has opened the quote page. Staff previews never
   increment this - see sb_quote_public(text, boolean).';

comment on column public.quotes.last_viewed_at is
  'Most recent customer open. viewed_at stays the FIRST open; a quote opened
   again weeks later is a reason to call, and that needs both ends.';

-- --------------------------------------------------------------------------
-- Counting
-- --------------------------------------------------------------------------
--
-- Replaces the version in db/quote-preview.sql. The signature is unchanged,
-- so the Netlify function needs no edit.
--
-- What changed: the update used to fire ONLY on the sent -> viewed
-- transition, so a second open did nothing at all. It now runs on every
-- customer open, and the status change is what became conditional.

drop function if exists public.sb_quote_public(text);
drop function if exists public.sb_quote_public(text, boolean);

create or replace function public.sb_quote_public(
  p_token text,
  p_mark  boolean default true
)
returns table (
  customer_name text,
  address       text,
  service_keys  text[],
  amount        numeric,
  note          text,
  status        text,
  expires_at    timestamptz,
  expired       boolean,
  accepted_at   timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  q public.quotes%rowtype;
begin
  select * into q from public.quotes where quotes.token = p_token;
  if not found then
    return; -- zero rows: the caller can't tell a bad token from a deleted one
  end if;

  -- coalesce, because a caller passing an explicit NULL means "I don't know
  -- who this is" — and not knowing has to fall on the side of recording the
  -- open, or a malformed request becomes a way to read a quote invisibly.
  if coalesce(p_mark, true) then
    update public.quotes
       set
           -- Only sent -> viewed. An accepted or declined quote is never
           -- walked backwards just because the link was opened again — but
           -- it IS still counted, because a customer rereading a quote they
           -- accepted is a real thing that happened.
           status = case when quotes.status = 'sent' then 'viewed' else quotes.status end,
           -- First open, kept forever.
           viewed_at = coalesce(quotes.viewed_at, now()),
           -- Most recent open, overwritten every time.
           last_viewed_at = now(),
           view_count = quotes.view_count + 1
     where quotes.id = q.id
    returning quotes.status into q.status;
  end if;

  return query select
    q.customer_name, q.address, q.service_keys, q.amount, q.note, q.status,
    q.expires_at,
    -- Computed, not stored. A nightly job to flip expired quotes would be a
    -- cron that can fail; a comparison cannot.
    (now() > q.expires_at) as expired,
    q.accepted_at;
  -- Deliberately NOT returned: view_count. This function serves the
  -- customer's own page, and telling somebody "you have opened this 4 times"
  -- is unsettling in a way that has no upside. The count is for the CRM.
end;
$$;

grant execute on function public.sb_quote_public(text, boolean) to anon, authenticated;

-- --------------------------------------------------------------------------
-- Showing it in the CRM
-- --------------------------------------------------------------------------
--
-- quotes_for_contact() gains the two columns. Dropped first because
-- `create or replace` refuses to change a return type — the same note
-- db/quote-history.sql made when it predicted this would happen.

drop function if exists public.quotes_for_contact(uuid, uuid);

create or replace function public.quotes_for_contact(
  p_lead_id     uuid default null,
  p_customer_id uuid default null
)
returns table (
  id             uuid,
  token          text,
  lead_id        uuid,
  customer_id    uuid,
  customer_name  text,
  amount         numeric,
  status         text,
  service_keys   text[],
  note           text,
  created_at     timestamptz,
  sent_at        timestamptz,
  viewed_at      timestamptz,
  last_viewed_at timestamptz,
  view_count     integer,
  accepted_at    timestamptz,
  expires_at     timestamptz,
  sender_name    text,
  from_elsewhere boolean
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
  select q.id,
         q.token,
         q.lead_id,
         q.customer_id,
         q.customer_name,
         q.amount,
         q.status,
         q.service_keys,
         q.note,
         q.created_at,
         q.sent_at,
         q.viewed_at,
         q.last_viewed_at,
         q.view_count,
         q.accepted_at,
         q.expires_at,
         p.full_name,
         -- coalesce on each half, and it is load bearing. A quote created
         -- from a lead has customer_id NULL, so viewed from a customer
         -- `q.customer_id = p_customer_id` is NULL rather than false — and
         -- `false or NULL` is NULL, which `not` leaves as NULL. The flag came
         -- back null on exactly the rows it exists to mark.
         not (
           coalesce(p_lead_id     is not null and q.lead_id     = p_lead_id,     false) or
           coalesce(p_customer_id is not null and q.customer_id = p_customer_id, false)
         )
  from public.quotes q
  left join public.profiles p on p.id = q.sent_by
  where q.lead_id     = any(ident.lead_ids)
     or q.customer_id = any(ident.customer_ids)
  order by q.created_at desc;
end;
$$;

comment on function public.quotes_for_contact(uuid, uuid) is
  'Every quote belonging to this person, whether it was sent to them as a
   lead or as a customer. Resolved through contact_identity(), so quotes
   follow the human rather than the row they happened to be created against.';

grant execute on function public.quotes_for_contact(uuid, uuid) to authenticated;
