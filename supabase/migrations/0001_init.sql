-- 0001_init: core schema for Field QA Copilot.
--
-- Access model:
--   anon           SELECT on every table except synthetic_truth and ai_jobs; no writes.
--   authenticated  nothing (the app has no end-user auth).
--   service_role   full access; all writes go through the server with this key.

-- Keeps updated_at current on tables that are edited in place.
create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Projects and people ---------------------------------------------------------

create table public.projects (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  region      text,
  start_date  date,
  end_date    date,
  created_at  timestamptz not null default now()
);

create table public.areas (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects (id) on delete cascade,
  name        text not null,
  boundary    jsonb
);
comment on column public.areas.boundary is 'GeoJSON geometry (Polygon or MultiPolygon).';
create index areas_project_id_idx on public.areas (project_id);

create table public.contributors (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects (id) on delete cascade,
  code          text not null,
  display_name  text,
  kind          text not null check (kind in ('enumerator', 'participant')),
  area_id       uuid references public.areas (id) on delete set null,
  created_at    timestamptz not null default now(),
  unique (project_id, code)
);
comment on column public.contributors.code is 'Short field code such as E07, unique per project.';
create index contributors_area_id_idx on public.contributors (area_id);

-- Submissions -----------------------------------------------------------------

create table public.submissions (
  id                    uuid primary key default gen_random_uuid(),
  project_id            uuid not null references public.projects (id) on delete cascade,
  contributor_id        uuid not null references public.contributors (id),
  client_submission_id  text not null unique,
  device_id             text,
  captured_at           timestamptz not null,
  synced_at             timestamptz not null default now(),
  duration_sec          int,
  lat                   double precision,
  lng                   double precision,
  gps_accuracy_m        real,
  answers               jsonb not null default '{}'::jsonb,
  voice_note_path       text,
  voice_transcript      text,
  transcript_lang       text,
  source                text not null check (source in ('synthetic', 'simulator', 'live')),
  created_at            timestamptz not null default now()
);
comment on column public.submissions.client_submission_id is 'Generated on the phone; makes offline retries idempotent.';
comment on column public.submissions.captured_at is 'When the phone recorded the submission.';
comment on column public.submissions.synced_at is 'When the server received it.';
comment on column public.submissions.answers is 'Shape: {"water_source": text, "satisfaction": int[8], "open_text": text}.';
comment on column public.submissions.voice_note_path is 'Object path in the private voice-notes Storage bucket.';
create index submissions_contributor_captured_idx on public.submissions (contributor_id, captured_at);
create index submissions_project_synced_idx on public.submissions (project_id, synced_at);

-- Ground truth for synthetic data. Only scripts/evaluate.py reads this table;
-- detection code must never read it.
create table public.synthetic_truth (
  submission_id  uuid primary key references public.submissions (id) on delete cascade,
  is_fabricated  boolean not null,
  fraud_type     text
);

-- Detection output ------------------------------------------------------------

create table public.check_results (
  submission_id   uuid not null references public.submissions (id) on delete cascade,
  check_key       text not null,
  fired           boolean not null,
  weight          real,
  evidence        jsonb,
  engine_version  text not null,
  created_at      timestamptz not null default now(),
  primary key (submission_id, check_key, engine_version)
);

create table public.scores (
  submission_id   uuid primary key references public.submissions (id) on delete cascade,
  score           real not null,
  flagged         boolean not null,
  config          jsonb,
  engine_version  text not null,
  scored_at       timestamptz not null default now()
);

create table public.reviews (
  id             uuid primary key default gen_random_uuid(),
  submission_id  uuid not null references public.submissions (id) on delete cascade,
  decision       text not null check (decision in ('approve', 'backcheck', 'reject')),
  note           text,
  reviewer       text,
  created_at     timestamptz not null default now()
);
create index reviews_submission_id_idx on public.reviews (submission_id);

-- Background work and briefs --------------------------------------------------

create table public.ai_jobs (
  id             uuid primary key default gen_random_uuid(),
  submission_id  uuid references public.submissions (id) on delete cascade,
  kind           text not null check (kind in ('transcribe', 'contradiction', 'brief')),
  status         text not null default 'queued'
                   check (status in ('queued', 'running', 'done', 'failed')),
  input          jsonb,
  output         jsonb,
  error          text,
  attempts       int not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index ai_jobs_submission_id_idx on public.ai_jobs (submission_id);
create trigger ai_jobs_set_updated_at
  before update on public.ai_jobs
  for each row execute function public.set_updated_at();

create table public.briefs (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects (id) on delete cascade,
  for_date    date not null,
  content_md  text,
  stats       jsonb,
  model       text,
  created_at  timestamptz not null default now(),
  unique (project_id, for_date)
);

create table public.check_config (
  project_id  uuid primary key references public.projects (id) on delete cascade,
  params      jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);
create trigger check_config_set_updated_at
  before update on public.check_config
  for each row execute function public.set_updated_at();

-- Row level security ----------------------------------------------------------

alter table public.projects        enable row level security;
alter table public.areas           enable row level security;
alter table public.contributors    enable row level security;
alter table public.submissions     enable row level security;
alter table public.synthetic_truth enable row level security;
alter table public.check_results   enable row level security;
alter table public.scores          enable row level security;
alter table public.reviews         enable row level security;
alter table public.ai_jobs         enable row level security;
alter table public.briefs          enable row level security;
alter table public.check_config    enable row level security;

-- Table privileges are set explicitly rather than relying on platform defaults.
revoke all on all tables in schema public from anon, authenticated;
grant all on all tables in schema public to service_role;
grant select on
  public.projects, public.areas, public.contributors, public.submissions,
  public.check_results, public.scores, public.reviews, public.briefs,
  public.check_config
to anon;

create policy "anon can read projects"      on public.projects      for select to anon using (true);
create policy "anon can read areas"         on public.areas         for select to anon using (true);
create policy "anon can read contributors"  on public.contributors  for select to anon using (true);
create policy "anon can read submissions"   on public.submissions   for select to anon using (true);
create policy "anon can read check_results" on public.check_results for select to anon using (true);
create policy "anon can read scores"        on public.scores        for select to anon using (true);
create policy "anon can read reviews"       on public.reviews       for select to anon using (true);
create policy "anon can read briefs"        on public.briefs        for select to anon using (true);
create policy "anon can read check_config"  on public.check_config  for select to anon using (true);
-- synthetic_truth and ai_jobs have no policies and no grants for anon or authenticated.

-- Realtime --------------------------------------------------------------------

alter publication supabase_realtime add table public.submissions, public.scores, public.reviews;

-- Storage ---------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('voice-notes', 'voice-notes', false)
on conflict (id) do nothing;
