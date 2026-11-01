// Shapes returned by the FastAPI routes under /api/py.

export type Band = "flagged" | "watch" | "clear";
export type ContributorStatus = "investigate" | "watch" | "ok";
export type CheckKey =
  | "too_fast"
  | "same_spot"
  | "copied_text"
  | "straight_lining"
  | "voice_vs_form"
  | "off_hours"
  | "shared_device"
  | "burst";
export type Decision = "approve" | "backcheck" | "reject";

export interface Project {
  id: string;
  name: string;
  region: string;
  timezone: string;
  as_of: string | null;
}

export interface ContributorRow {
  contributor_id: string;
  code: string;
  kind: "enumerator" | "participant";
  display_name: string | null;
  area: string | null;
  submissions: number;
  flagged: number;
  watch: number;
  flag_rate: number;
  mean_score: number;
  median_duration_sec: number | null;
  checks_fired: Partial<Record<CheckKey, number>>;
  last_captured_at: string;
  status: ContributorStatus;
}

export interface Hotspot {
  contributor_id: string;
  contributor_code: string;
  count: number;
  centroid: { lat: number; lng: number };
  radius_m: number;
  first_date: string;
  last_date: string;
  days: number;
  avg_duration_sec: number | null;
  off_hours_share: number;
  mostly_off_hours: boolean;
  submission_ids: string[];
}

export interface DayStats {
  date: string;
  received: number;
  flagged: number;
  watch: number;
  pending_review: number;
  median_duration_sec: number | null;
  checks_fired: Partial<Record<CheckKey, number>>;
  flagged_by_contributor: Record<string, number>;
}

export interface AreaRate {
  area: string;
  submissions: number;
  flagged: number;
  watch: number;
  flag_rate: number;
}

export interface Overview {
  project: Project;
  engine_version: string;
  now: string;
  now_is_fixed: boolean;
  thresholds: { review: number; watch: number };
  kpis: {
    received: number;
    flagged: number;
    watch: number;
    pending_review: number;
    contributors_to_investigate: number;
  };
  contributors: ContributorRow[];
  areas: AreaRate[];
  hotspots: Hotspot[];
  today: DayStats;
  yesterday: DayStats;
}

export interface MapPoint {
  id: string;
  code: string;
  kind: "enumerator" | "participant";
  lat: number;
  lng: number;
  score: number;
  band: Band;
  fired: CheckKey[];
  captured_at: string;
  duration_sec: number | null;
}

export interface MapArea {
  id: string;
  name: string;
  boundary: { type: "Polygon"; coordinates: number[][][] } | null;
}

export interface MapData {
  project: Project;
  thresholds: { review: number; watch: number };
  points: MapPoint[];
  areas: MapArea[];
  hotspots: Hotspot[];
}

export interface ContributorRef {
  id: string;
  code: string;
  display_name: string | null;
  kind: "enumerator" | "participant";
  area: string | null;
}

export interface Review {
  id: string;
  submission_id?: string;
  decision: Decision;
  note?: string | null;
  reviewer: string | null;
  created_at: string;
  revoked_at?: string | null;
}

export interface QueueItem {
  submission_id: string;
  contributor: ContributorRef;
  captured_at: string;
  score: number;
  band: Band;
  fired: CheckKey[];
  review: Review | null;
}

export interface CheckResult {
  key: CheckKey;
  fired: boolean;
  weight: number;
  evidence: Record<string, unknown>;
}

export interface SubmissionRow {
  id: string;
  client_submission_id: string;
  device_id: string | null;
  captured_at: string;
  synced_at: string;
  duration_sec: number | null;
  lat: number | null;
  lng: number | null;
  gps_accuracy_m: number | null;
  answers: { water_source?: string; satisfaction?: number[]; open_text?: string };
  voice_transcript: string | null;
  transcript_lang: string | null;
  voice_note_path: string | null;
  source: string;
}

export interface SubmissionDetail {
  submission: SubmissionRow;
  contributor: ContributorRef;
  score: { score: number; flagged: boolean; band: Band; engine_version: string; scored_at: string } | null;
  checks: CheckResult[];
  review: Review | null;
}

export interface CheckMetrics {
  fires_on: number;
  precision: number | null;
  recall: number | null;
  targeted_recall: number | null;
}

export interface EvaluateResult {
  engine_version: string;
  params: {
    review_threshold: number;
    watch_threshold: number;
    weights: Record<CheckKey, number>;
    too_fast_min_minutes: { enumerator: number; participant: number };
    same_spot_radius_m: number;
    copy_similarity: number;
    [key: string]: unknown;
  };
  combined: {
    threshold: number;
    submissions: number;
    fabricated: number;
    flagged: number;
    watch: number;
    false_positives: number;
    false_negatives: number;
    precision: number | null;
    recall: number | null;
  };
  per_check: Record<CheckKey, CheckMetrics>;
  sweep?: { threshold: number; precision: number | null; recall: number | null; flagged: number }[];
  cached: boolean;
  timing_ms: Record<string, number>;
}

export interface IngestResponse {
  id: string;
  client_submission_id: string;
  contributor: ContributorRef;
  captured_at: string;
  score: number | null;
  flagged: boolean | null;
  band: Band | null;
  engine_version: string | null;
  fired: { key: CheckKey; weight: number; evidence: Record<string, unknown> }[];
  changed: { submission_id: string; flagged: boolean; previously_flagged: boolean; score: number }[];
  duplicate: boolean;
  healed: boolean;
  timing_ms?: Record<string, number>;
}
