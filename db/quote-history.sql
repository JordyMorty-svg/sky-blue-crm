-- Sky Blue CRM — quotes follow the person, not the row
--
-- Run once in the Supabase SQL editor, after db/quotes.sql. Safe to re-run.
--
-- THE PROBLEM. A quote sent from a lead carries lead_id and nothing else. When
-- that lead accepts, books, and becomes a customer, the quote stays attached
-- to the lead — so the customer's profile showed "No quotes sent yet" about
-- the very quote that won the job. The most useful record in the system was
-- invisible from the page people actually open.
--
-- Backfilling quotes.customer_id when a lead converts would fix the common
-- case and quietly miss the rest: one person is often several leads (knocked
-- in spring, called back in autumn) and the quotes on the leads that did NOT
-- convert are exactly the ones worth seeing before quoting them again.
--
-- So this resolves the PERSON at read time, the same way the contact timeline
-- already does, using the same contact_identity() function — which exists
-- precisely because no single foreign key ties one human together.

-- ---------------------------------------------------------------------------

-- Dropped first: `create or replace` refuses to change a return type, and
-- this one will gain columns as the quote record grows.
drop function if exists public.quotes_for_contact(uuid, uuid);

create or replace function public.quotes_for_contact(
  p_lead_id     uuid default null,
  p_customer_id uuid default null
)
returns table (
  id            uuid,
  token         text,
  lead_id       uuid,
  customer_id   uuid,
  customer_name text,
  amount        numeric,
  status        text,
  service_keys  text[],
  note          text,
  created_at    timestamptz,
  sent_at       timestamptz,
  viewed_at     timestamptz,
  accepted_at   timestamptz,
  expires_at    timestamptz,
  sender_name   text,
  -- True when this quote is attached to a DIFFERENT record from the one being
  -- viewed. The page says so rather than showing it silently: a quote that
  -- appears on a customer's profile with no explanation looks like a
  -- duplicate of one somebody already sent.
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
