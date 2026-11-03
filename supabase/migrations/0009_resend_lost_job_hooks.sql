-- 0009: re-send job hooks that never arrived.
--
-- pg_net delivers the job hook once. When that POST fails ("Error in the HTTP2
-- framing layer": 2 of 213 deliveries in round 8 testing), the job stays queued
-- and nothing runs it, so the phone keeps saying "Transcribing…". Every 30 s,
-- POST the hook again for jobs still queued 30 s after they were created, for up
-- to 10 minutes. /jobs/run claims a job at most once, so a repeat is harmless.

create extension if not exists pg_cron;

create function public.resend_stale_job_hooks(min_age_seconds integer default 30, max_age_seconds integer default 600)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  hook_url text;
  hook_secret text;
  stale record;
  sent integer := 0;
begin
  select decrypted_secret into hook_url from vault.decrypted_secrets where name = 'job_hook_url';
  select decrypted_secret into hook_secret from vault.decrypted_secrets where name = 'job_hook_secret';
  if hook_url is null or hook_secret is null then
    return 0;
  end if;
  for stale in
    select id from public.ai_jobs
    where status = 'queued' and notify
      and created_at < now() - make_interval(secs => min_age_seconds)
      and created_at > now() - make_interval(secs => max_age_seconds)
    order by created_at
    limit 20
  loop
    perform net.http_post(
      url := hook_url || '/api/py/jobs/run',
      body := jsonb_build_object('job_id', stale.id),
      headers := jsonb_build_object('Content-Type', 'application/json', 'X-Jobs-Secret', hook_secret),
      timeout_milliseconds := 120000
    );
    sent := sent + 1;
  end loop;
  return sent;
end;
$$;

revoke all on function public.resend_stale_job_hooks(integer, integer) from public, anon, authenticated;

select cron.schedule('resend-stale-job-hooks', '30 seconds', 'select public.resend_stale_job_hooks()');
