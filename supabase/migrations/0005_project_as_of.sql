-- 0005: a project's own "now". When as_of is set, "today", "yesterday" and the
-- daily brief anchor to it instead of the wall clock, so a demo replays a
-- fixed day. Null means the real time.
alter table public.projects add column as_of timestamptz;
comment on column public.projects.as_of is
  'Optional fixed "now" for the project (demos). Today/yesterday/brief use it when set; null means real time.';

-- The demo project: morning of Oct 31 in Kisumu, so yesterday is Oct 30 and
-- the live day streams in as today.
update public.projects
set as_of = timestamptz '2026-10-31 08:00:00 Africa/Nairobi'
where name = 'Household Water Access Survey';
