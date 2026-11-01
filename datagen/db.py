"""Batched writes to Supabase over PostgREST, authenticated with the service role key."""

import httpx


class SupabaseError(RuntimeError):
    pass


class Supabase:
    def __init__(self, url: str, service_key: str, timeout: float = 60.0) -> None:
        self._http = httpx.Client(
            base_url=f"{url.rstrip('/')}/rest/v1",
            headers={"apikey": service_key, "Content-Type": "application/json"},
            timeout=timeout,
        )

    def _check(self, response: httpx.Response) -> httpx.Response:
        if response.is_error:
            raise SupabaseError(f"{response.request.method} {response.request.url.path}: "
                                f"{response.status_code} {response.text}")
        return response

    def count(self, table: str, **filters: str) -> int:
        response = self._check(self._http.get(
            f"/{table}", params={"select": "*", **filters},
            headers={"Prefer": "count=exact", "Range": "0-0"},
        ))
        return int(response.headers["content-range"].split("/")[1])

    def delete(self, table: str, **filters: str) -> None:
        self._check(self._http.delete(f"/{table}", params=filters, headers={"Prefer": "return=minimal"}))

    def insert(self, table: str, rows: list[dict], batch_size: int = 500) -> None:
        for start in range(0, len(rows), batch_size):
            self._check(self._http.post(f"/{table}", json=rows[start:start + batch_size],
                                        headers={"Prefer": "return=minimal"}))

    def close(self) -> None:
        self._http.close()
