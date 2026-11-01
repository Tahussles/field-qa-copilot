"""Minimal PostgREST client for the offline scripts, authenticated with the service role key."""

from pathlib import Path

import httpx


class SupabaseError(RuntimeError):
    pass


def load_env(path: Path) -> dict[str, str]:
    env = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            env[key.strip()] = value.strip()
    return env


class Supabase:
    def __init__(self, url: str, service_key: str, timeout: float = 60.0) -> None:
        self._http = httpx.Client(
            base_url=f"{url.rstrip('/')}/rest/v1",
            headers={"apikey": service_key, "Content-Type": "application/json"},
            timeout=timeout,
        )

    @classmethod
    def from_env_file(cls, path: Path) -> "Supabase":
        env = load_env(path)
        url, key = env.get("NEXT_PUBLIC_SUPABASE_URL"), env.get("SUPABASE_SERVICE_ROLE_KEY")
        if not url or not key:
            raise SupabaseError(f"NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in {path}")
        return cls(url, key)

    def _check(self, response: httpx.Response) -> httpx.Response:
        if response.is_error:
            raise SupabaseError(f"{response.request.method} {response.request.url.path}: "
                                f"{response.status_code} {response.text}")
        return response

    def count(self, table: str, select: str = "*", **filters: str) -> int:
        response = self._check(self._http.get(
            f"/{table}", params={"select": select, **filters},
            headers={"Prefer": "count=exact", "Range": "0-0"},
        ))
        return int(response.headers["content-range"].split("/")[1])

    def select(self, table: str, select: str = "*", page_size: int = 1000, **filters: str) -> list[dict]:
        """All matching rows, fetched page by page. Pass order=... for a stable result."""
        rows: list[dict] = []
        while True:
            response = self._check(self._http.get(
                f"/{table}", params={"select": select, **filters},
                headers={"Range": f"{len(rows)}-{len(rows) + page_size - 1}"},
            ))
            page = response.json()
            rows.extend(page)
            if len(page) < page_size:
                return rows

    def delete(self, table: str, **filters: str) -> None:
        self._check(self._http.delete(f"/{table}", params=filters, headers={"Prefer": "return=minimal"}))

    def insert(self, table: str, rows: list[dict], batch_size: int = 500) -> None:
        for start in range(0, len(rows), batch_size):
            self._check(self._http.post(f"/{table}", json=rows[start:start + batch_size],
                                        headers={"Prefer": "return=minimal"}))

    def upsert(self, table: str, rows: list[dict], on_conflict: str, batch_size: int = 500) -> None:
        """Insert, or update rows that collide on the on_conflict columns."""
        for start in range(0, len(rows), batch_size):
            self._check(self._http.post(
                f"/{table}", params={"on_conflict": on_conflict}, json=rows[start:start + batch_size],
                headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
            ))

    def close(self) -> None:
        self._http.close()
