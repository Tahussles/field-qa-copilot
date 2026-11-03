-- 0011: the phone's clock against the server's (engine 0.5.0, clock_skew).
--
-- device_synced_at is the phone's own clock when it sent the submission, and
-- received_at the server's when it arrived (synced_at is on the field clock
-- during a demo, so it cannot serve). A phone with a right clock has them
-- seconds apart; clock_skew fires when they are more than 5 minutes apart.
-- ingest_begin stores both and returns them, with gps_accuracy_m and
-- device_captured_at, for every submission in the scoring group, so an
-- incremental rescore of a neighbour sees what a full rescore sees.

alter table public.submissions
  add column device_synced_at timestamptz,
  add column received_at timestamptz;
comment on column public.submissions.device_synced_at is
  'The phone''s own clock when it sent this submission (live phones).';
comment on column public.submissions.received_at is
  'The server''s own clock when the submission arrived (synced_at is on the field clock during a demo).';

-- Ingest stores and returns the clock fields; otherwise unchanged from 0010.
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
                                    device_captured_at, synced_at, device_synced_at, received_at, duration_sec, lat,
                                    lng, gps_accuracy_m, answers, voice_transcript, transcript_lang, voice_note_path,
                                    source)
    select r.id, r.project_id, r.contributor_id, r.client_submission_id, r.device_id, r.captured_at,
           r.device_captured_at, r.synced_at, r.device_synced_at, r.received_at, r.duration_sec, r.lat, r.lng,
           r.gps_accuracy_m, r.answers, r.voice_transcript, r.transcript_lang, r.voice_note_path, r.source
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
        'gps_accuracy_m', s.gps_accuracy_m, 'device_captured_at', s.device_captured_at,
        'device_synced_at', s.device_synced_at, 'received_at', s.received_at,
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
