-- 0004: two calls per arrival instead of eight.
--
-- ingest_begin   lease, idempotent insert, and fetch the scoring context
-- ingest_commit  write the results Python computed, check the lease, release it
--
-- These functions only fetch and write. Every decision about scores (the
-- checks, the weights, whether a stored score needs healing) stays in Python.

-- The stored record a retry gets back: the row, its score and its fired checks.
create function public.ingest_stored_view(submission_id uuid, engine_version text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'submission', to_jsonb(s),
    'score', (select to_jsonb(sc) from public.scores sc where sc.submission_id = s.id),
    'checks', coalesce((
      select jsonb_agg(to_jsonb(cr) order by cr.check_key)
      from public.check_results cr
      where cr.submission_id = s.id and cr.fired and cr.engine_version = ingest_stored_view.engine_version
    ), '[]'::jsonb)
  )
  from public.submissions s
  where s.id = ingest_stored_view.submission_id;
$$;

-- Returns {status: duplicate | busy | inserted | heal, ...}.
--   duplicate  the client_submission_id exists (and heal was not asked): stored view, no lease taken
--   busy       another arrival holds an overlapping lease; retry shortly
--   inserted   new row stored; leases held; group = everything needed to rescore
--   heal       (heal = true) leases held around the stored row; group as above
-- Leases cover every contributor and device whose results this arrival can read
-- or change: its contributor and device, the other accounts on that device and
-- the contributor's other devices. They expire after ttl_seconds, so a crashed
-- request never blocks anyone for longer than that.
create function public.ingest_begin(submission jsonb, lock_holder uuid, engine_version text,
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
                                    transcript_lang, source)
    select r.id, r.project_id, r.contributor_id, r.client_submission_id, r.device_id, r.captured_at, r.synced_at,
           r.duration_sec, r.lat, r.lng, r.gps_accuracy_m, r.answers, r.voice_transcript, r.transcript_lang, r.source
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
    ), '[]'::jsonb)
  );
end;
$$;

-- Writes check_results and scores, then releases the holder's leases.
-- Fencing: if any of the holder's leases expired (and so may now belong to
-- someone else), nothing is written and the call fails with FQ409; the client
-- retries and the retry heals. Unchanged rows are not rewritten, so Realtime
-- only reports scores that actually changed.
create function public.ingest_commit(check_rows jsonb, score_rows jsonb, lock_holder uuid, expected_locks integer)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  held integer;
  written integer := 0;
  n integer;
begin
  select count(*) into held from public.scoring_locks l
  where l.holder = lock_holder and l.expires_at > now();
  if held < expected_locks then
    raise exception 'scoring lease lost (holding %, expected %)', held, expected_locks
      using errcode = 'FQ409';
  end if;

  insert into public.check_results (submission_id, check_key, fired, weight, evidence, engine_version)
  select r.submission_id, r.check_key, r.fired, r.weight, r.evidence, r.engine_version
  from jsonb_to_recordset(check_rows)
    as r(submission_id uuid, check_key text, fired boolean, weight real, evidence jsonb, engine_version text)
  on conflict (submission_id, check_key, engine_version) do update
    set fired = excluded.fired, weight = excluded.weight, evidence = excluded.evidence, created_at = now()
    where (check_results.fired, check_results.weight, check_results.evidence)
          is distinct from (excluded.fired, excluded.weight, excluded.evidence);
  get diagnostics n = row_count;
  written := written + n;

  insert into public.scores (submission_id, score, flagged, config, engine_version, scored_at)
  select r.submission_id, r.score, r.flagged, r.config, r.engine_version, now()
  from jsonb_to_recordset(score_rows)
    as r(submission_id uuid, score real, flagged boolean, config jsonb, engine_version text)
  on conflict (submission_id) do update
    set score = excluded.score, flagged = excluded.flagged, config = excluded.config,
        engine_version = excluded.engine_version, scored_at = excluded.scored_at
    where (scores.score, scores.flagged, scores.config, scores.engine_version)
          is distinct from (excluded.score, excluded.flagged, excluded.config, excluded.engine_version);
  get diagnostics n = row_count;
  written := written + n;

  delete from public.scoring_locks where holder = lock_holder;
  return written;
end;
$$;

revoke all on function public.ingest_stored_view(uuid, text) from public, anon, authenticated;
revoke all on function public.ingest_begin(jsonb, uuid, text, integer, boolean) from public, anon, authenticated;
revoke all on function public.ingest_commit(jsonb, jsonb, uuid, integer) from public, anon, authenticated;
grant execute on function public.ingest_stored_view(uuid, text) to service_role;
grant execute on function public.ingest_begin(jsonb, uuid, text, integer, boolean) to service_role;
grant execute on function public.ingest_commit(jsonb, jsonb, uuid, integer) to service_role;
