-- db/property-default-sync.sql — the default address IS the customer's address
--
-- Run db/properties.sql first. Idempotent; safe to re-run.
--
-- THE BUG THIS FIXES. Make a second property the default and the picker,
-- the booking screen and the quote modal all follow it immediately — but
-- the customer record still said the old address, because nothing was
-- keeping the two in step. So the profile showed one house, every new job
-- was booked at another, and both were "correct" according to whichever
-- part of the app you asked.
--
-- WHICH ONE IS THE TRUTH. The property, and this file makes customers
-- follow it rather than the other way round:
--
--   * a customer has one address column and can have several buildings, so
--     the column can only ever be a summary of the set
--   * every address in customer_properties was either typed into the
--     Google autocomplete or copied from this column by the backfill, so
--     the properties are at least as good as the column and usually better
--     (they carry coordinates)
--   * jobs and quotes already resolve through the property first — see
--     sb_job_address() — so the column is the fallback, and a fallback that
--     disagrees with the thing it is backing up is worse than no fallback
--
-- A TRIGGER, NOT A CHANGE TO sb_set_primary_property(). The RPC is one of
-- four routes to a row being primary: the RPC itself, the first property
-- created for a customer, the backfill in db/properties.sql, and anybody
-- editing the table directly. Patching the RPC fixes one of them and leaves
-- three ways to end up out of step again.

-- ---------------------------------------------------------------------------
-- 1. Keep the customer's address pointing at their default property
-- ---------------------------------------------------------------------------

create or replace function public.sb_sync_customer_address()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.customers c
     set address   = new.address,
         latitude  = new.latitude,
         longitude = new.longitude
   where c.id = new.customer_id
     -- ONLY WHEN SOMETHING ACTUALLY CHANGED. Without this, every touch of
     -- a primary property writes the customers row, which fires whatever
     -- is on customers and, more to the point, bumps it in any
     -- "recently changed" list for no reason.
     and (c.address, c.latitude, c.longitude)
         is distinct from (new.address, new.latitude, new.longitude);

  return null;   -- AFTER trigger; the return value is ignored.
end;
$$;

drop trigger if exists customer_properties_sync_address on public.customer_properties;

-- AFTER, not BEFORE: this writes a different table, and nothing about the
-- row being saved needs changing.
--
-- The WHEN clause is what keeps this cheap and, more importantly, what
-- stops it firing on the wrong rows. Archiving a property sets is_primary
-- false and must NOT blank the customer's address — they still live
-- somewhere, and "we retired that address" is not "we lost it".
create trigger customer_properties_sync_address
  after insert or update on public.customer_properties
  for each row
  when (new.is_primary and new.archived_at is null)
  execute function public.sb_sync_customer_address();

comment on function public.sb_sync_customer_address() is
  'Mirrors the default property onto customers.address/latitude/longitude.
   The property is the truth; the column is a summary of it.';

-- ---------------------------------------------------------------------------
-- 2. Catch up anybody already out of step
-- ---------------------------------------------------------------------------
--
-- Customers whose default was changed between db/properties.sql and this
-- file. Nothing told their customer row, so it still carries whatever it
-- had when the backfill ran.

update public.customers c
   set address   = p.address,
       latitude  = p.latitude,
       longitude = p.longitude
  from public.customer_properties p
 where p.customer_id = c.id
   and p.is_primary
   and p.archived_at is null
   and (c.address, c.latitude, c.longitude)
       is distinct from (p.address, p.latitude, p.longitude);

-- ---------------------------------------------------------------------------
-- 3. Diagnostic
-- ---------------------------------------------------------------------------
-- READ ONLY. After section 2 this should always print zero; it is here so
-- that a future change which breaks the trigger shows up as a number rather
-- than as a customer quietly booked at the wrong house.

do $$
declare n int;
begin
  select count(*) into n
    from public.customers c
    join public.customer_properties p
      on p.customer_id = c.id and p.is_primary and p.archived_at is null
   where coalesce(c.address, '') is distinct from coalesce(p.address, '');

  if n = 0 then
    raise notice 'Every customer''s address matches their default property.';
  else
    raise notice '% customer(s) still disagree with their default property.', n;
  end if;
end $$;
