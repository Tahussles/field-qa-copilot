"""Minimal PostgREST client for Supabase, authenticated with the service role key.

Shared by the API (SupabaseRepo) and the offline scripts.
"""

import os
from pathlib import Path
from typing import Any

import httpx


class SupabaseError(RuntimeError):
    def __init__(self, message: str, status: int | None = None, code: str | None = None):
        super().__init__(message)
        self.status = status
        self.code = code  # Postgres error code, e.g. 23505 for a unique violation


def load_env(path: Path) -> dict[str, str]:
    env = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            env[key.strip()] = value.strip()
    return env


def in_list(values) -> str:
    """A PostgREST in.(...) filter with each value quoted."""
    return "in.(" + ",".join('"' + str(v).replace('"', '\\"') + '"' for v in values) + ")"


class Supabase:
    def __init__(self, url: str, service_key: str, timeout: float = 60.0) -> None:
        self._http = httpx.Client(
            base_url=f"{url.rstrip('/')}/rest/v1",
            headers={"apikey": service_key, "Content-Type": "application/json"},
            timeout=timeout,
        )
        self._storage = httpx.Client(base_url=f"{url.rstrip('/')}/storage/v1", headers={"apikey": service_key},
                                     timeout=timeout)
        self.service_key = service_key

    @classmethod
    def from_env_file(cls, path: Path) -> "Supabase":
        """From the environment (CI), else the file (.env.local)."""
        env = load_env(path) if path.exists() else {}
        url = os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or env.get("NEXT_PUBLIC_SUPABASE_URL")
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or env.get("SUPABASE_SERVICE_ROLE_KEY")
        if not url or not key:
            raise SupabaseError(f"NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (env or {path})")
        return cls(url, key)

    def _check(self, response: httpx.Response) -> httpx.Response:
        # 3xx counts too: PostgREST answers 300 for an ambiguous embed.
        if response.status_code >= 300:
            code = None
            try:
                code = response.json().get("code")
            except ValueError:
                pass
            raise SupabaseError(f"{response.request.method} {response.request.url.path}: "
                                f"{response.status_code} {response.text}", response.status_code, code)
        return response

    def _get(self, path: str, params: dict, headers: dict) -> httpx.Response:
        """Reads are idempotent: one retry after a timeout or a dropped connection."""
        try:
            return self._check(self._http.get(path, params=params, headers=headers))
        except httpx.TransportError:  # includes timeouts
            return self._check(self._http.get(path, params=params, headers=headers))

    def count(self, table: str, select: str = "*", **filters: str) -> int:
        response = self._get(f"/{table}", {"select": select, **filters}, {"Prefer": "count=exact", "Range": "0-0"})
        return int(response.headers["content-range"].split("/")[1])

    def first(self, table: str, select: str = "*", **filters: str) -> tuple[dict | None, int]:
        """The first matching row (pass order=...) and the total count, in one request."""
        response = self._get(f"/{table}", {"select": select, **filters}, {"Prefer": "count=exact", "Range": "0-0"})
        rows = response.json()
        return (rows[0] if rows else None), int(response.headers["content-range"].split("/")[1])

    def select(self, table: str, select: str = "*", page_size: int = 1000, **filters: str) -> list[dict]:
        """All matching rows, fetched page by page. Pass order=... for a stable result."""
        rows: list[dict] = []
        while True:
            response = self._get(f"/{table}", {"select": select, **filters},
                                 {"Range": f"{len(rows)}-{len(rows) + page_size - 1}"})
            page = response.json()
            rows.extend(page)
            if len(page) < page_size:
                return rows

    def delete(self, table: str, **filters: str) -> None:
        self._check(self._http.delete(f"/{table}", params=filters, headers={"Prefer": "return=minimal"}))

    def insert(self, table: str, rows: list[dict], batch_size: int = 500, returning: bool = False) -> list[dict]:
        out: list[dict] = []
        prefer = "return=representation" if returning else "return=minimal"
        for start in range(0, len(rows), batch_size):
            response = self._check(self._http.post(f"/{table}", json=rows[start:start + batch_size],
                                                   headers={"Prefer": prefer}))
            if returning:
                out.extend(response.json())
        return out

    def upsert(self, table: str, rows: list[dict], on_conflict: str, batch_size: int = 500) -> None:
        """Insert, or update rows that collide on the on_conflict columns."""
        for start in range(0, len(rows), batch_size):
            self._check(self._http.post(
                f"/{table}", params={"on_conflict": on_conflict}, json=rows[start:start + batch_size],
                headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
            ))

    def update(self, table: str, values: dict, **filters: str) -> list[dict]:
        response = self._check(self._http.patch(f"/{table}", params=filters, json=values,
                                                headers={"Prefer": "return=representation"}))
        return response.json()

    def upsert_returning(self, table: str, rows: list[dict], on_conflict: str, ignore: bool = False) -> list[dict]:
        """Upsert and return the rows written. ignore=True keeps existing rows and returns only new ones."""
        resolution = "ignore-duplicates" if ignore else "merge-duplicates"
        response = self._check(self._http.post(f"/{table}", params={"on_conflict": on_conflict}, json=rows,
                                               headers={"Prefer": f"resolution={resolution},return=representation"}))
        return response.json()

    # Storage (private buckets, service role)
    def download(self, bucket: str, path: str) -> bytes:
        return self._check(self._storage.get(f"/object/{bucket}/{path}")).content

    def upload(self, bucket: str, path: str, data: bytes, content_type: str) -> None:
        self._check(self._storage.post(f"/object/{bucket}/{path}", content=data,
                                       headers={"Content-Type": content_type, "x-upsert": "true"}))

    def signed_upload_url(self, bucket: str, path: str) -> str:
        """A one-off URL a browser can PUT this object to (overwriting: retries reuse the path)."""
        signed = self._check(self._storage.post(f"/object/upload/sign/{bucket}/{path}",
                                                headers={"x-upsert": "true"})).json()
        return str(self._storage.base_url).rstrip("/") + signed["url"]

    def signed_url(self, bucket: str, path: str, seconds: int) -> str:
        """An absolute URL the browser can fetch for `seconds`."""
        signed = self._check(self._storage.post(f"/object/sign/{bucket}/{path}", json={"expiresIn": seconds})).json()
        return str(self._storage.base_url).rstrip("/") + signed["signedURL"]

    def rpc(self, function: str, args: dict[str, Any]) -> Any:
        response = self._check(self._http.post(f"/rpc/{function}", json=args))
        return response.json() if response.content else None  # void functions answer 204

    def close(self) -> None:
        self._http.close()
