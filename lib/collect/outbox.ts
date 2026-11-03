// The phone's outbox: every submission is saved here first (IndexedDB, voice note
// included), then a sync loop sends it when the phone is online. A retry reuses the
// same client_submission_id, so the API's idempotency returns the same record.

import type { IngestResponse } from "@/lib/types";

const DB_NAME = "fqc-collect";
const STORE = "outbox";

export type OutboxStatus = "waiting" | "syncing" | "synced" | "error";

export interface OutboxItem {
  client_submission_id: string;
  /** The POST /submissions body, without voice_note_path (set once the audio is uploaded). */
  body: Record<string, unknown>;
  audio: Blob | null;
  audio_type: string | null;
  voice_note_path: string | null;
  status: OutboxStatus;
  attempts: number;
  next_try_at: number;
  saved_at: string;
  synced_at: string | null;
  result: IngestResponse | null;
  error: string | null;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "client_submission_id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const request = run(db.transaction(STORE, mode).objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export const outbox = {
  put: (item: OutboxItem) => tx("readwrite", (s) => s.put(item)),
  get: (id: string) => tx<OutboxItem | undefined>("readonly", (s) => s.get(id)),
  all: async () =>
    ((await tx<OutboxItem[]>("readonly", (s) => s.getAll())) ?? []).sort((a, b) => a.saved_at.localeCompare(b.saved_at)),
  async update(id: string, patch: Partial<OutboxItem>) {
    const item = await outbox.get(id);
    if (item) await outbox.put({ ...item, ...patch });
  },
};

/** Exponential backoff for a failed send: 2, 4, 8 … seconds, at most a minute. */
export const backoffMs = (attempts: number) => Math.min(60_000, 2_000 * 2 ** Math.max(0, attempts - 1));
