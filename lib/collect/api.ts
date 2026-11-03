// The collect page's calls: a collect token (from the demo panel's QR code) or the
// demo passcode, never both. Sending one outbox item is upload-then-submit, and safe
// to repeat: the upload path and the client_submission_id stay the same.

import type { CollectSession, IngestResponse } from "@/lib/types";

import type { OutboxItem } from "./outbox";

export type Access = { token: string } | { passcode: string };

export class CollectError extends Error {
  constructor(
    public status: number,
    message: string,
    public retry: boolean,
  ) {
    super(message);
  }
}

function headers(access: Access, json = true): Headers {
  const h = new Headers();
  if (json) h.set("content-type", "application/json");
  if ("token" in access) h.set("x-collect-token", access.token);
  else h.set("x-demo-passcode", access.passcode);
  return h;
}

async function call<T>(path: string, access: Access, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/py${path}`, { ...init, headers: headers(access), cache: "no-store" });
  } catch {
    throw new CollectError(0, "no connection", true); // offline, or the response never arrived
  }
  if (!response.ok) {
    let message = response.statusText;
    try {
      const body = await response.json();
      message = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail ?? body);
    } catch {
      // keep the status text
    }
    // 5xx and 429 are worth retrying; a refused token or a bad body is not.
    throw new CollectError(response.status, message, response.status >= 500 || response.status === 429);
  }
  return response.json() as Promise<T>;
}

export const collectApi = {
  session: (access: Access) => call<CollectSession>("/collect/session", access),

  /** Upload (if any), then submit. Returns the stored record: 201 the first time, 200 on a retry. */
  async send(access: Access, item: OutboxItem): Promise<{ path: string | null; result: IngestResponse }> {
    let path = item.voice_note_path;
    if (item.audio && !path) {
      const type = (item.audio_type ?? item.audio.type).split(";")[0];
      const signed = await call<{ path: string; upload_url: string }>("/collect/upload", access, {
        method: "POST",
        body: JSON.stringify({ device_id: item.body.device_id, client_submission_id: item.client_submission_id, content_type: type }),
      });
      let put: Response;
      try {
        put = await fetch(signed.upload_url, { method: "PUT", body: item.audio, headers: { "content-type": type, "x-upsert": "true" } });
      } catch {
        throw new CollectError(0, "no connection", true);
      }
      if (!put.ok) throw new CollectError(put.status, `voice note upload failed (${put.status})`, put.status >= 500);
      path = signed.path;
    }
    const result = await call<IngestResponse>("/submissions", access, {
      method: "POST",
      body: JSON.stringify({ ...item.body, voice_note_path: path }),
    });
    return { path, result };
  },
};
