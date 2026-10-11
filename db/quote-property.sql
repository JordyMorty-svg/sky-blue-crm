-- db/quote-property.sql — which building is this quote for?
--
-- Run db/properties.sql first. Idempotent; safe to re-run.
--
-- THE SMALL CHANGE, AND WHY IT IS SMALL. db/quotes.sql already snapshots
-- the address onto the quote row, with the right reasoning already written
-- next to it:
--
--     "Snapshotted, not joined. A quote is an offer made at a moment: if
--      the lead's address is corrected next week, the quote the customer is
--      looking at must still say what it said when they got it."
--
-- That is correct and nothing here changes it. The gap was never how the
-- address is stored — it was that nothing ever ASKED which address. Every
-- caller passed `customer.address`, because until db/properties.sql a
-- customer only had one.
--
-- So this adds the pointer and leaves the snapshot alone:
--
--   quotes.property_id — which building was quoted. Null for every quote
--                        sent before today, and for a lead that has no
--                        customer record yet.
--
-- WHAT IT IS FOR, given the address is already frozen on the row:
--
--   * Accepting a quote should book the job at the building that was
--     quoted. quotes.closed_job_id already ties the two together; without
--     property_id the job has to guess, and it would guess the primary —
--     which for the customer who prompted all of this is the wrong house.
--   * "What have we quoted this building?" is a question with an answer
--     only if the quote names the building rather than a string that
--     happens to match today.
--
-- The address column stays the thing the customer sees. This is the thing
-- the CRM reasons with. They are allowed to disagree once a property is
-- renamed or corrected, and that is the point of having both.

alter table public.quotes
  add column if not exists property_id uuid
    -- on delete set null, like jobs.property_id. Deleting an address must
    -- never delete the record of a price we offered for it — and the quote
    -- keeps its own frozen copy of the address, so it stays readable.
    references public.customer_properties (id) on delete set null;

create index if not exists quotes_property_idx on public.quotes (property_id);

comment on column public.quotes.property_id is
  'Which building this quote is for. The address shown to the customer is
   the frozen quotes.address; this is the link the CRM reasons with.';

-- ---------------------------------------------------------------------------
-- Backfill: only where there is exactly one candidate
-- ---------------------------------------------------------------------------
--
-- DELIBERATELY TIMID. A quote whose address matches one of its customer's
-- properties is almost certainly for that property — but "almost certainly"
-- is doing real work in that sentence, and the whole reason this column
-- exists is a customer with two buildings a few miles apart.
--
-- So: only when the customer has exactly ONE property, and only when its
-- address matches the quote's. Anything ambiguous is left null, which reads
-- as "nobody recorded which building" — true, and better than a guess that
-- looks like a record.

update public.quotes q
   set property_id = p.id
  from public.customer_properties p
 where p.customer_id = q.customer_id
   and p.archived_at is null
   and q.property_id is null
   and q.customer_id is not null
   -- Case and surrounding space only. NOT fuzzy matching: "100 Model Home
   -- Way" and "100 Model Home Way, Corvallis, OR" are probably the same
   -- place, and probably is not good enough to stamp onto an offer.
   and lower(btrim(coalesce(q.address, ''))) = lower(btrim(p.address))
   and (
     select count(*) from public.customer_properties x
      where x.customer_id = q.customer_id and x.archived_at is null
   ) = 1;

-- ---------------------------------------------------------------------------
-- Diagnostic: quotes nobody can attribute to a building
-- ---------------------------------------------------------------------------
-- READ ONLY, and only interesting for customers who have more than one
-- property — everywhere else a null property_id is just history.

do $$
declare
  n int;
begin
  select count(*) into n
    from public.quotes q
   where q.property_id is null
     and q.customer_id is not null
     and (
       select count(*) from public.customer_properties x
        where x.customer_id = q.customer_id and x.archived_at is null
     ) > 1;

  if n > 0 then
    raise notice
      '% quote(s) belong to a customer with several properties and do not say '
      'which one. The address on each is still what the customer was shown; '
      'set property_id by hand if it matters.', n;
  else
    raise notice 'Every quote that could name a building does.';
  end if;
end $$;
