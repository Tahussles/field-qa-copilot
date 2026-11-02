-- 0006: two demo settings on the project.
--
-- day_pin      when set, "today" and "yesterday" (KPIs, the brief) anchor to this
--              local date even after as_of passes midnight. The demo's live day
--              syncs into the next morning; its numbers stay "today".
-- demo_run_id  changes on every demo reset. /demo/step must send the current one,
--              so a tab still running an old replay is stopped (409).
alter table public.projects
  add column day_pin date,
  add column demo_run_id uuid;

comment on column public.projects.day_pin is
  'Optional pinned "today" (local date) for a demo replay of one field day; null means the date of as_of.';
comment on column public.projects.demo_run_id is
  'Identifies the current demo run; a demo reset issues a new one and /demo/step must send it.';

update public.projects
set day_pin = date '2026-10-31', demo_run_id = gen_random_uuid()
where name = 'Household Water Access Survey';
