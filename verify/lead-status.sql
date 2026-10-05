\set ON_ERROR_STOP on

-- ###########################################################################
-- #  THIS FILE WRITES AND DELETES ROWS. Throwaway Postgres only, never      #
-- #  Supabase. db/*.sql are the real migrations; verify/*.sql are not.      #
-- ###########################################################################

do $$
begin
  if to_regclass('public._scratch_db') is null then
    raise exception 'REFUSING TO RUN. verify/ file; needs verify/sms-fixture.sql first.';
  end if;
end $$;

-- Assertions for db/lead-status-constraint.sql.
--
-- The bug: the status dropdown is built in JavaScript and the column is
-- constrained in SQL, and nothing made them agree. 'lost' was added to the
-- app; the constraint still listed six statuses; marking a lead Lost failed
-- for months with "Couldn't save. Try again." on screen.

create or replace function pg_temp.chk(what text, pass boolean, detail text default null)
returns void language plpgsql as $$
begin
  if pass then raise notice 'ok    %', what;
  else raise exception 'FAIL  %  %', what, coalesce('— ' || detail, '');
  end if;
end $$;

do $$
declare
  lid   uuid;
  threw text;
begin
  insert into public.leads (name, status) values ('Kathy O''Reilly', 'quoted')
  returning id into lid;

  -- THE POINT. This is the exact save that failed on the lead page.
  begin
    update public.leads set status = 'lost' where id = lid;
    threw := null;
  exception when others then
    threw := SQLERRM;
  end;
  perform pg_temp.chk('THE POINT: a lead can be marked lost', threw is null,
    coalesce(threw, ''));

  perform pg_temp.chk('...and it stuck',
    (select status from public.leads where id = lid) = 'lost');

  -- Nobody has tried this one yet, and it was broken the same way.
  update public.leads set status = 'quoted' where id = lid;
  begin
    update public.leads set status = 'archived' where id = lid;
    threw := null;
  exception when others then
    threw := SQLERRM;
  end;
  perform pg_temp.chk('THE POINT: archived was broken too, and is not any more',
    threw is null, coalesce(threw, ''));

  -- Widened, not removed. A constraint that was dropped rather than replaced
  -- would pass every check above and protect nothing.
  begin
    update public.leads set status = 'banana' where id = lid;
    threw := null;
  exception when others then
    threw := SQLERRM;
  end;
  perform pg_temp.chk('THE POINT: the column is still constrained, not just unlocked',
    threw is not null,
    'dropping the constraint would make every assertion above pass and guard nothing');

  perform pg_temp.chk('the constraint is there by name',
    exists (select 1 from pg_constraint c
            join pg_class r on r.oid = c.conrelid
            where r.relname = 'leads' and c.conname = 'leads_status_check'));

  delete from public.leads where id = lid;
end $$;

-- Every status the app can set, one at a time, against the real column.
do $$
declare
  s     text;
  lid   uuid;
  threw text;
begin
  insert into public.leads (name, status) values ('Status sweep', 'new')
  returning id into lid;

  foreach s in array array['new','contacted','quoted','booked',
                           'scheduled','completed','lost','archived'] loop
    begin
      update public.leads set status = s where id = lid;
      threw := null;
    exception when others then
      threw := SQLERRM;
    end;
    perform pg_temp.chk(format('status %L saves', s), threw is null, coalesce(threw, ''));
  end loop;

  delete from public.leads where id = lid;
end $$;

do $$
begin
  raise notice '';
  raise notice 'all ok — every status the dropdown offers, the column accepts';
end $$;
