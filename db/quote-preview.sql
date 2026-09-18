-- db/quote-preview.sql
--
-- Lets a member of staff LOOK at a quote page without the customer being
-- recorded as having read it.
--
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- --------------------------------------------------------------------------
-- The problem this fixes
-- --------------------------------------------------------------------------
--
-- sb_quote_public() flips a quote from 'sent' to 'viewed' on any load, and
-- the database has no way to tell a curious rep from the customer. That flag
-- is load-bearing in two places: the Quotes panel shows "Opened, not
-- accepted", which is the most actionable state in the list, and
-- sms_due_quote_nudges() sends a different chaser for a quote that was opened
-- than for one that never was.
--
-- The Quotes panel offers **Copy link**, and pasting that link into a browser
-- to check it looked right marked the quote as read by a customer who had not
-- seen it — then sent them the wrong follow-up, or none.
--
-- Leaving the marking out of the database was never an option: the customer's
-- open has to be recorded, and the only place that knows a page was fetched
-- is the thing that serves it. So the decision moves UP a level. The caller —
-- netlify/functions/quote-public.mjs — verifies the request's bearer token
-- against Supabase Auth, and only a request it could NOT identify as staff
-- marks the quote. A customer has no token to present.
--
-- p_mark defaults to TRUE so the dangerous direction is never the one you get
-- by forgetting an argument. A caller that says nothing gets the old, safe-
-- for-customers behaviour; suppressing the mark has to be asked for.

-- The old single-argument signature is dropped rather than left alongside.
-- Postgres would happily keep both, and `sb_quote_public('abc')` would then
-- be ambiguous — which PostgREST resolves by guessing.
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

  -- First open, by someone who isn't us. Only moves sent -> viewed; never
  -- walks an accepted quote backwards just because the link was opened again.
  --
  -- coalesce, because a caller that passes an explicit NULL means "I don't
  -- know who this is" — and not knowing has to fall on the side of recording
  -- the open, or a malformed request becomes a way to read a quote invisibly.
  if coalesce(p_mark, true) and q.status = 'sent' then
    update public.quotes
       set status = 'viewed', viewed_at = coalesce(viewed_at, now())
     where id = q.id;
    q.status := 'viewed';
  end if;

  return query select
    q.customer_name, q.address, q.service_keys, q.amount, q.note, q.status,
    q.expires_at,
    -- Computed, not stored. A nightly job to flip expired quotes would be a
    -- cron that can fail; a comparison cannot.
    (now() > q.expires_at) as expired,
    q.accepted_at;
end;
$$;

grant execute on function public.sb_quote_public(text, boolean) to anon, authenticated;

-- --------------------------------------------------------------------------
-- Which quotes might be wrongly marked?
-- --------------------------------------------------------------------------
--
-- Read-only. Nothing below changes a row — paste it into the SQL editor to
-- see what the old behaviour may have mismarked.
--
-- There is no field that distinguishes a staff open from a customer's, which
-- is the whole reason this migration exists, so this cannot be authoritative.
-- What it CAN do is narrow it to the ones worth a human look: a quote viewed
-- suspiciously soon after it was sent is far more likely to be the person who
-- just sent it, checking their work, than a customer who happened to be
-- holding their phone.
--
--   select
--     q.id,
--     q.customer_name,
--     q.amount,
--     q.sent_at,
--     q.viewed_at,
--     round(extract(epoch from (q.viewed_at - q.sent_at)))          as seconds_after_send,
--     p.full_name                                                    as sent_by,
--     case
--       when q.viewed_at - q.sent_at < interval '2 minutes' then 'almost certainly staff'
--       when q.viewed_at - q.sent_at < interval '30 minutes' then 'possibly staff'
--       else 'probably the customer'
--     end                                                            as guess
--   from public.quotes q
--   left join public.profiles p on p.id = q.sent_by
--   where q.status = 'viewed'
--   order by q.viewed_at - q.sent_at asc nulls last;
--
-- To put one back, having decided it was you — one at a time, by id, never
-- as a bulk update:
--
--   update public.quotes
--      set status = 'sent', viewed_at = null
--    where id = '<the id>'
--      and status = 'viewed';
--
-- The `and status = 'viewed'` is not decoration. It means running this twice,
-- or running it on a quote the customer has since accepted, does nothing
-- rather than dragging a booked job back to 'sent'.
