-- 0002: project timezone for local-time checks, and noise tags on synthetic truth.

alter table public.projects
  add column timezone text not null default 'Africa/Nairobi';
comment on column public.projects.timezone is
  'IANA timezone for local-time logic: off_hours and same-day grouping use captured_at in this zone.';

-- Why a genuine synthetic row may look suspicious. Set by the generator, read
-- only by scripts/evaluate.py, never by detection code.
alter table public.synthetic_truth
  add column noise_tag text
    check (noise_tag in (
      'short_genuine', 'straightline_genuine', 'two_source_transcript',
      'compound_cluster', 'late_capture', 'late_sync'
    )),
  add constraint synthetic_truth_noise_only_on_genuine
    check (noise_tag is null or not is_fabricated);
