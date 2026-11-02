-- 0007: the AI layer.
--
-- Checks stay deterministic code. A model only (a) transcribes voice notes,
-- (b) judges meaning (voice vs form, reworded copies) and (c) writes the brief.
-- Its judgments are stored as inputs in ai_verdicts; the engine reads them and,
-- with no verdict, the rule-based check stands. ai_jobs drives all model work.

-- Verdicts ---------------------------------------------------------------------

create table public.ai_verdicts (
  id                  uuid primary key default gen_random_uuid(),
  submission_id       uuid not null references public.submissions (id) on delete cascade,
  -- paraphrase verdicts are about a pair: the other submission
  pair_submission_id  uuid references public.submissions (id) on delete cascade,
  kind                text not null check (kind in ('voice_vs_form', 'paraphrase')),
  model               text not null,
  verdict             jsonb not null,
  created_at          timestamptz not null default now()
);
create unique index ai_verdicts_subject_key on public.ai_verdicts
  (submission_id, kind, coalesce(pair_submission_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index ai_verdicts_pair_idx on public.ai_verdicts (pair_submission_id);

-- Jobs -------------------------------------------------------------------------
-- One row per unit of model work. dedupe_key makes queueing idempotent: the same
-- work is never queued twice, and a finished job only reruns when forced (its
-- status is set back to queued).

alter table public.ai_jobs drop constraint ai_jobs_kind_check;
alter table public.ai_jobs add constraint ai_jobs_kind_check
  check (kind in ('transcribe', 'consistency', 'paraphrase', 'brief', 'tts'));
alter table public.ai_jobs
  add column project_id    uuid references public.projects (id) on delete cascade,
  add column dedupe_key    text not null unique,
  add column notify        boolean not null default true,  -- false: a script runs it (backfill), no webhook
  add column model         text,
  add column input_tokens  integer,
  add column output_tokens integer,
  add column latency_ms    integer,
  add column cost_usd      numeric(12, 6),
  add column started_at    timestamptz,
  add column finished_at   timestamptz;
create index ai_jobs_status_idx on public.ai_jobs (status, created_at);

-- Claim a job for running: queued, or running but abandoned (a crashed worker).
create function public.claim_ai_job(job_id uuid, stale_seconds integer default 180)
returns setof public.ai_jobs
language sql
set search_path = ''
as $$
  update public.ai_jobs
  set status = 'running', started_at = now(), attempts = attempts + 1, error = null
  where id = job_id
    and (status = 'queued' or (status = 'running' and started_at < now() - make_interval(secs => stale_seconds)))
  returning *;
$$;

-- The same for up to max_jobs of the oldest claimable jobs (the drain safety net).
create function public.claim_ai_jobs(max_jobs integer, stale_seconds integer default 180)
returns setof public.ai_jobs
language sql
set search_path = ''
as $$
  update public.ai_jobs j
  set status = 'running', started_at = now(), attempts = attempts + 1, error = null
  where j.id in (
    select q.id from public.ai_jobs q
    where q.status = 'queued' or (q.status = 'running' and q.started_at < now() - make_interval(secs => stale_seconds))
    order by q.created_at
    limit max_jobs
    for update skip locked
  )
  returning j.*;
$$;

-- The trigger: a new (or re-queued) job is POSTed to the API right away, from
-- pg_net's background worker, so the insert never waits. URL and shared secret
-- live in Vault, set by set_job_hook() (scripts/set_job_hook.py).
create extension if not exists pg_net with schema extensions;

create function public.set_job_hook(hook_url text, hook_secret text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from vault.secrets where name in ('job_hook_url', 'job_hook_secret');
  perform vault.create_secret(hook_url, 'job_hook_url', 'Where new ai_jobs are POSTed');
  perform vault.create_secret(hook_secret, 'job_hook_secret', 'X-Jobs-Secret for the job hook');
end;
$$;

create function public.notify_job_hook()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  hook_url text;
  hook_secret text;
begin
  if not new.notify or new.status <> 'queued' then
    return new;
  end if;
  select decrypted_secret into hook_url from vault.decrypted_secrets where name = 'job_hook_url';
  select decrypted_secret into hook_secret from vault.decrypted_secrets where name = 'job_hook_secret';
  if hook_url is null or hook_secret is null then
    return new;  -- no hook configured: /jobs/drain picks the job up
  end if;
  perform net.http_post(
    url := hook_url || '/api/py/jobs/run',
    body := jsonb_build_object('job_id', new.id),
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Jobs-Secret', hook_secret),
    timeout_milliseconds := 120000
  );
  return new;
end;
$$;

create trigger ai_jobs_notify_insert
  after insert on public.ai_jobs
  for each row execute function public.notify_job_hook();
create trigger ai_jobs_notify_requeue
  after update of status on public.ai_jobs
  for each row when (new.status = 'queued' and old.status is distinct from 'queued')
  execute function public.notify_job_hook();

-- Briefs: one per (project, day, data version), AI-written or the template fallback.
alter table public.briefs drop constraint briefs_project_id_for_date_key;
alter table public.briefs
  add column data_version text not null default '',
  add column status       text not null default 'ai' check (status in ('ai', 'template')),
  add column items        jsonb,
  add column fallback     jsonb,   -- why the template was used, when it was
  add column audio_path   text;    -- brief-audio bucket, once read aloud
alter table public.briefs add constraint briefs_project_day_version_key unique (project_id, for_date, data_version);

insert into storage.buckets (id, name, public) values ('brief-audio', 'brief-audio', false)
on conflict (id) do nothing;

-- Ingest also hands back the group's verdicts (still one call) and stores voice_note_path.
create or replace function public.ingest_begin(submission jsonb, lock_holder uuid, engine_version text,
                                    ttl_seconds integer default 15, heal boolean default false)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  existing public.submissions;
  stored public.submissions;
  is_new boolean;
  cid uuid;
  did text;
  pid uuid;
  lock_keys text[];
  contributor_ids uuid[];
  device_ids text[];
begin
  select * into existing from public.submissions s
  where s.client_submission_id = submission->>'client_submission_id';
  is_new := existing.id is null;

  if not is_new and not heal then
    return jsonb_build_object('status', 'duplicate')
           || public.ingest_stored_view(existing.id, ingest_begin.engine_version);
  end if;

  if is_new then
    cid := (submission->>'contributor_id')::uuid;
    did := submission->>'device_id';
    pid := (submission->>'project_id')::uuid;
  else
    cid := existing.contributor_id;
    did := existing.device_id;
    pid := existing.project_id;
  end if;

  select array_agg(distinct c) into contributor_ids from (
    select cid as c
    union select s.contributor_id from public.submissions s where did is not null and s.device_id = did
  ) cs;
  select coalesce(array_agg(distinct d), '{}') into device_ids from (
    select did as d where did is not null
    union select s.device_id from public.submissions s where s.contributor_id = cid and s.device_id is not null
  ) ds;
  select array_agg(k order by k) into lock_keys from (
    select 'contributor:' || c::text as k from unnest(contributor_ids) c
    union select 'device:' || d from unnest(device_ids) d
  ) ks;

  if not public.acquire_scoring_locks(lock_keys, lock_holder, ttl_seconds) then
    return jsonb_build_object('status', 'busy', 'lock_keys', to_jsonb(lock_keys));
  end if;

  if is_new then
    insert into public.submissions (id, project_id, contributor_id, client_submission_id, device_id, captured_at,
                                    synced_at, duration_sec, lat, lng, gps_accuracy_m, answers, voice_transcript,
                                    transcript_lang, voice_note_path, source)
    select r.id, r.project_id, r.contributor_id, r.client_submission_id, r.device_id, r.captured_at, r.synced_at,
           r.duration_sec, r.lat, r.lng, r.gps_accuracy_m, r.answers, r.voice_transcript, r.transcript_lang,
           r.voice_note_path, r.source
    from jsonb_populate_record(null::public.submissions, submission) r
    on conflict (client_submission_id) do nothing
    returning * into stored;
    if stored.id is null then
      -- The same retry raced us between the lookup and the insert.
      delete from public.scoring_locks where holder = lock_holder;
      select * into existing from public.submissions s
      where s.client_submission_id = submission->>'client_submission_id';
      return jsonb_build_object('status', 'duplicate')
             || public.ingest_stored_view(existing.id, ingest_begin.engine_version);
    end if;
  else
    stored := existing;
  end if;

  return jsonb_build_object(
    'status', case when is_new then 'inserted' else 'heal' end,
    'submission', to_jsonb(stored),
    'lock_keys', to_jsonb(lock_keys),
    'group', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id, 'contributor_id', s.contributor_id, 'device_id', s.device_id, 'captured_at', s.captured_at,
        'synced_at', s.synced_at, 'duration_sec', s.duration_sec, 'lat', s.lat, 'lng', s.lng,
        'answers', s.answers, 'voice_transcript', s.voice_transcript) order by s.id)
      from public.submissions s
      where s.project_id = pid and (s.contributor_id = any(contributor_ids) or s.device_id = any(device_ids))
    ), '[]'::jsonb),
    'scores', coalesce((
      select jsonb_agg(jsonb_build_object('submission_id', sc.submission_id, 'score', sc.score,
                                          'flagged', sc.flagged, 'engine_version', sc.engine_version))
      from public.scores sc join public.submissions s on s.id = sc.submission_id
      where s.project_id = pid and (s.contributor_id = any(contributor_ids) or s.device_id = any(device_ids))
    ), '[]'::jsonb),
    'verdicts', coalesce((
      select jsonb_agg(jsonb_build_object('submission_id', v.submission_id, 'pair_submission_id', v.pair_submission_id,
                                          'kind', v.kind, 'model', v.model, 'verdict', v.verdict))
      from public.ai_verdicts v join public.submissions s on s.id = v.submission_id
      where s.project_id = pid and (s.contributor_id = any(contributor_ids) or s.device_id = any(device_ids))
    ), '[]'::jsonb)
  );
end;
$$;

-- Access ------------------------------------------------------------------------
-- Verdicts and job status are read-only for the browser (Realtime drives the UI).
-- Nothing in them is ground truth: inputs are transcripts and answers anon can
-- already read, outputs are the model's judgments.
alter table public.ai_verdicts enable row level security;
grant select on public.ai_verdicts, public.ai_jobs to anon;
create policy "anon can read ai_verdicts" on public.ai_verdicts for select to anon using (true);
create policy "anon can read ai_jobs" on public.ai_jobs for select to anon using (true);
grant all on public.ai_verdicts to service_role;

revoke all on function public.claim_ai_job(uuid, integer) from public, anon, authenticated;
revoke all on function public.claim_ai_jobs(integer, integer) from public, anon, authenticated;
revoke all on function public.set_job_hook(text, text) from public, anon, authenticated;
revoke all on function public.notify_job_hook() from public, anon, authenticated;
grant execute on function public.claim_ai_job(uuid, integer) to service_role;
grant execute on function public.claim_ai_jobs(integer, integer) to service_role;
grant execute on function public.set_job_hook(text, text) to service_role;

alter publication supabase_realtime add table public.ai_verdicts, public.ai_jobs, public.briefs;
