-- 0008: AI spend survives demo resets, a "skipped" job status, short language codes,
-- and limits on what phones may upload.

-- A reset deletes live submissions; their jobs (and what they cost) stay, detached,
-- marked with the demo run they belonged to.
alter table public.ai_jobs drop constraint ai_jobs_submission_id_fkey;
alter table public.ai_jobs add constraint ai_jobs_submission_id_fkey
  foreign key (submission_id) references public.submissions (id) on delete set null;
alter table public.ai_jobs add column demo_run_id uuid;
create index ai_jobs_demo_run_idx on public.ai_jobs (demo_run_id);

create function public.stamp_ai_job_demo_run()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.demo_run_id is null and new.submission_id is not null then
    select p.demo_run_id into new.demo_run_id
    from public.submissions s join public.projects p on p.id = s.project_id
    where s.id = new.submission_id and s.source in ('simulator', 'live');
  end if;
  return new;
end;
$$;
create trigger ai_jobs_stamp_demo_run
  before insert on public.ai_jobs
  for each row execute function public.stamp_ai_job_demo_run();

-- skipped: a deployment without the model's key; the rule stands, nothing failed.
alter table public.ai_jobs drop constraint ai_jobs_status_check;
alter table public.ai_jobs add constraint ai_jobs_status_check
  check (status in ('queued', 'running', 'done', 'failed', 'skipped'));

-- What the AI layer has cost: all time, and for one demo run. Fetch only.
create function public.ai_spend(project uuid, run uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'all_time_usd', coalesce(sum(cost_usd), 0),
    'all_time_jobs', count(*),
    'run_usd', coalesce(sum(cost_usd) filter (where demo_run_id = run), 0),
    'run_jobs', count(*) filter (where demo_run_id = run)
  )
  from public.ai_jobs where project_id = project;
$$;
revoke all on function public.ai_spend(uuid, uuid) from public, anon, authenticated;
grant execute on function public.ai_spend(uuid, uuid) to service_role;
revoke all on function public.stamp_ai_job_demo_run() from public, anon, authenticated;

-- Short language codes: en, sw, luo (Dholuo). Scribe reports ISO 639-3.
update public.submissions set transcript_lang = case transcript_lang when 'eng' then 'en' when 'swa' then 'sw' end
where transcript_lang in ('eng', 'swa');

-- Phones upload voice notes through signed URLs: audio only, 5 MB at most (60 s is well under 1 MB).
update storage.buckets
set file_size_limit = 5242880,
    allowed_mime_types = array['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/x-m4a', 'audio/mpeg',
                               'audio/wav', 'audio/x-wav']
where id = 'voice-notes';
