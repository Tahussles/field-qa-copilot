// Thin client for the FastAPI routes. Same origin: Next rewrites /api/py/* to Python.

import type {
  Decision,
  DemoResetResult,
  DemoStatus,
  DemoStepResult,
  EvaluateResult,
  IngestResponse,
  MapData,
  Overview,
  QueueItem,
  Review,
  SubmissionDetail,
} from "./types";

const BASE = "/api/py";
const PASSCODE_KEY = "fqc-demo-passcode";
const REVIEWER_KEY = "fqc-reviewer";

/** Name decisions are recorded under: "dashboard" unless set (the smoke test uses "smoke-test"). */
function reviewerName(): string {
  try {
    return window.localStorage.getItem(REVIEWER_KEY) || "dashboard";
  } catch {
    return "dashboard";
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit & { passcode?: string }): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("content-type", "application/json");
  if (init?.passcode) headers.set("x-demo-passcode", init.passcode);
  const response = await fetch(`${BASE}${path}`, { ...init, headers, cache: "no-store" });
  if (!response.ok) {
    let message = response.statusText;
    try {
      const body = await response.json();
      message = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail ?? body);
    } catch {
      // keep the status text
    }
    throw new ApiError(response.status, message);
  }
  return response.json() as Promise<T>;
}

export const api = {
  overview: () => request<Overview>("/overview"),
  map: () => request<MapData>("/map"),
  queue: (params: { status: string; band: string; contributor?: string; limit?: number }) => {
    const query = new URLSearchParams({ status: params.status, band: params.band, limit: String(params.limit ?? 500) });
    if (params.contributor) query.set("contributor", params.contributor);
    return request<{ total: number; items: QueueItem[] }>(`/queue?${query}`);
  },
  submission: (id: string) => request<SubmissionDetail>(`/submissions/${id}`),
  evaluate: (params: Record<string, unknown>, sweep = true) =>
    request<EvaluateResult>("/evaluate", { method: "POST", body: JSON.stringify({ params, sweep }) }),
  review: (passcode: string, submissionId: string, decision: Decision) =>
    request<Review>("/reviews", {
      method: "POST",
      passcode,
      body: JSON.stringify({ submission_id: submissionId, decision, reviewer: reviewerName() }),
    }),
  undoReview: (passcode: string, reviewId: string) =>
    request<Review>(`/reviews/${reviewId}`, { method: "DELETE", passcode }),
  submit: (passcode: string, body: Record<string, unknown>) =>
    request<IngestResponse>("/submissions", { method: "POST", passcode, body: JSON.stringify(body) }),
  demoStatus: (passcode: string) => request<DemoStatus>("/demo/status", { passcode }),
  demoStep: (passcode: string, body: { run_id: string; count?: number; until_field_time?: string }) =>
    request<DemoStepResult>("/demo/step", { method: "POST", passcode, body: JSON.stringify(body) }),
  demoReset: (passcode: string) => request<DemoResetResult>("/demo/reset", { method: "POST", passcode }),
};

export const passcodeStore = {
  get(): string | null {
    try {
      return window.localStorage.getItem(PASSCODE_KEY);
    } catch {
      return null;
    }
  },
  set(value: string) {
    try {
      window.localStorage.setItem(PASSCODE_KEY, value);
    } catch {
      // private mode: the modal will ask again next time
    }
  },
  clear() {
    try {
      window.localStorage.removeItem(PASSCODE_KEY);
    } catch {
      // nothing stored
    }
  },
};
