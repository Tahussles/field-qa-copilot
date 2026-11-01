-- 0003: one active review per submission (undo keeps history), and short
-- leases that serialise incremental scoring per contributor and device.

-- Reviews: undo marks a decision revoked instead of deleting it.
alter table public.reviews add column revoked_at timestamptz;
create unique index reviews_one_active_per_submission
  on public.reviews (submission_id) where revoked_at is null;

-- Device lookups for incremental scoring (shared_device, copied_text partners).
create index submissions_device_idx on public.submissions (device_id);

-- Scoring locks. PostgREST runs every call in its own transaction on a pooled
-- connection, so session advisory locks can't span the several calls one
-- arrival needs. Instead each arrival takes short leases on its keys
-- ("contributor:<id>", "device:<id>"); a crashed holder's lease simply expires.
create table public.scoring_locks (
  key         text primary key,
  holder      uuid not null,
  expires_at  timestamptz not null
);
alter table public.scoring_locks enable row level security;
revoke all on public.scoring_locks from anon, authenticated;
grant all on public.scoring_locks to service_role;

-- All-or-nothing: returns true only if every key was free (or expired).
create function public.acquire_scoring_locks(lock_keys text[], lock_holder uuid, ttl_seconds integer default 15)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  taken integer;
begin
  delete from public.scoring_locks where key = any(lock_keys) and expires_at < now();
  insert into public.scoring_locks (key, holder, expires_at)
  select k, lock_holder, now() + make_interval(secs => ttl_seconds)
  from (select distinct unnest(lock_keys) as k order by 1) keys  -- fixed order avoids deadlocks
  on conflict (key) do nothing;
  get diagnostics taken = row_count;
  if taken < (select count(distinct k) from unnest(lock_keys) as k) then
    delete from public.scoring_locks where holder = lock_holder;
    return false;
  end if;
  return true;
end;
$$;

create function public.release_scoring_locks(lock_holder uuid)
returns void
language sql
set search_path = ''
as $$
  delete from public.scoring_locks where holder = lock_holder;
$$;

revoke all on function public.acquire_scoring_locks(text[], uuid, integer) from public, anon, authenticated;
revoke all on function public.release_scoring_locks(uuid) from public, anon, authenticated;
grant execute on function public.acquire_scoring_locks(text[], uuid, integer) to service_role;
grant execute on function public.release_scoring_locks(uuid) to service_role;
