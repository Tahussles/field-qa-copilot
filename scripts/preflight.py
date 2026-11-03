"""Preflight for a live demo: a green/red checklist against production, about 30 minutes before.

    pnpm preflight                                   # = uv run scripts/preflight.py
    uv run scripts/preflight.py --base https://<deployment>.vercel.app

Checks, in order: the network path to production (TCP connects over IPv4 and
IPv6: a flaky path stalls a connect for 20-35 s); production health and engine version; the basemap tile host;
a collect token mint (and the phone session it opens); an ingest latency sample
with a Realtime round trip; one phone interview with a voice note, end to end on
production (one ElevenLabs transcription and one Claude judgment, about $0.001);
/overview, /map, /evaluate, /landing and /brief warmed. Then a demo reset and
verify_wave.py. Exit 1 on any red. Prints no secret.
"""

import argparse
import json
import os
import statistics
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from api._lib.postgrest import load_env  # noqa: E402
from engine import __version__  # noqa: E402

PROD = "https://field-qa-copilot.vercel.app"
# The poket theme's map (the default) and the linear theme's; both read the same vector tiles.
STYLE_URLS = ("https://tiles.openfreemap.org/styles/positron", "https://tiles.openfreemap.org/styles/dark")
VOICE_NOTE = ROOT / "tests-e2e" / "fixtures" / "pipe-dry.wav"
KISUMU_TILE = (13, 4887, 4097)  # z, x, y around Kondele
GREEN, RED, DIM, END = ("\033[32m", "\033[31m", "\033[2m", "\033[0m") if sys.stdout.isatty() else ("", "", "", "")


class Red(Exception):
    """A check that failed, with what to say about it."""


def ms(start: float) -> int:
    return round((time.perf_counter() - start) * 1000)


class Preflight:
    def __init__(self, base: str, env: dict):
        self.base = base.rstrip("/")
        self.api = f"{self.base}/api/py"
        self.env = env
        self.auth = {"X-Demo-Passcode": env["DEMO_PASSCODE"]}
        self.http = httpx.Client(timeout=60)
        self.results: list[tuple[bool, str, str]] = []

    def check(self, name: str, fn) -> object:
        try:
            detail, value = fn()
            ok = True
        except Red as red:
            detail, value, ok = str(red), None, False
        except Exception as error:  # noqa: BLE001  a check that crashes is red, not a traceback
            detail, value, ok = f"{type(error).__name__}: {error}", None, False
        self.results.append((ok, name, detail))
        mark = f"{GREEN}✓{END}" if ok else f"{RED}✗{END}"
        print(f"{mark} {name:<26} {detail}", flush=True)
        return value

    def live_body(self, client_id: str, device: str, **extra) -> dict:
        return {"contributor_code": "E03", "device_id": device, "client_submission_id": client_id,
                "captured_at": datetime.now(timezone.utc).isoformat(), "device_synced_at": datetime.now(timezone.utc).isoformat(),
                "duration_sec": 1500, "lat": -0.0745, "lng": 34.7862, "gps_accuracy_m": 8.0,
                # No open answer: similar ones would queue paraphrase checks (model calls) for every sample.
                "answers": {"water_source": "piped_home", "satisfaction": [3, 2, 4, 3, 2, 4, 3, 2], "open_text": ""},
                "source": "live", **extra}

    # The checks ---------------------------------------------------------------------------

    def network(self):
        """Ten TCP connects per address family. This machine's path, not production: a lost SYN costs 20 s or more."""
        host = self.base.split("//", 1)[1].split("/", 1)[0]
        report, slow = [], []
        for family in ("4", "6"):
            times = []
            for _ in range(10):
                run = subprocess.run(["curl", f"-{family}", "-s", "-o", "/dev/null", "--max-time", "8", "-w", "%{time_connect}",
                                      f"https://{host}/api/py/health"], capture_output=True, text=True)
                times.append(float(run.stdout or 8) if run.returncode == 0 else None)
            reachable = [t for t in times if t is not None]
            if not reachable and family == "6":
                report.append("IPv6 none")
                continue
            worst = max(t if t is not None else 8 for t in times)
            report.append(f"IPv{family} worst {worst * 1000:.0f} ms")
            if worst > 2:
                slow.append(f"IPv{family} stalled {sum(t is None or t > 2 for t in times)}/10")
        detail = " · ".join(report) + " (10 connects each)"
        if slow:
            raise Red(detail + f"; {', '.join(slow)}: use another network, or turn IPv6 off on this one")
        return detail, None

    def health(self):
        start = time.perf_counter()
        h = self.http.get(f"{self.api}/health").raise_for_status().json()
        took = ms(start)
        head = subprocess.run(["git", "rev-parse", "origin/main"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
        problems = []
        if h.get("engine_version") != __version__:
            problems.append(f"engine {h.get('engine_version')} != local {__version__}")
        if h.get("writes") is not True:
            problems.append("writes are off")
        if head and h.get("commit") and h["commit"] != head:
            problems.append(f"serves {h['commit'][:7]}, origin/main is {head[:7]}")
        detail = f"engine {h.get('engine_version')} · commit {(h.get('commit') or '?')[:7]} · writes on · {took} ms"
        if problems:
            raise Red("; ".join(problems))
        return detail, h

    def tiles(self):
        start = time.perf_counter()
        style = self.http.get(STYLE_URLS[0]).raise_for_status().json()
        for other in STYLE_URLS[1:]:
            self.http.get(other).raise_for_status()
        source = next(iter(s for s in style["sources"].values() if s.get("url")))
        tilejson = self.http.get(source["url"]).raise_for_status().json()
        z, x, y = KISUMU_TILE
        tile = self.http.get(tilejson["tiles"][0].format(z=z, x=x, y=y))
        if tile.status_code != 200 or not tile.content:
            raise Red(f"tile HTTP {tile.status_code}")
        return f"both styles, tilejson and a Kisumu tile ({len(tile.content) // 1024} kB) in {ms(start)} ms", None

    def collect_token(self):
        start = time.perf_counter()
        minted = self.http.post(f"{self.api}/collect/token", json={}, headers=self.auth).raise_for_status().json()
        session = self.http.get(f"{self.api}/collect/session", headers={"X-Collect-Token": minted["token"]})
        session.raise_for_status()
        left = round((minted["expires_at"] - time.time()) / 60)
        return (f"minted ({len(minted['path'])}-char URL, {left} min), opens {len(session.json()['contributors'])} "
                f"contributors · {ms(start)} ms"), None

    def ingest_and_realtime(self, judge: bool = True):
        client_id = f"preflight-{uuid.uuid4()}"
        device = f"phone-preflight{uuid.uuid4().hex[:8]}"
        node = subprocess.Popen(["node", "--env-file=.env.local", "scripts/realtime-roundtrip.mjs", client_id],
                                cwd=ROOT, stdout=subprocess.PIPE, text=True)
        line = node.stdout.readline().split()
        if not line or line[0] != "subscribed":
            node.kill()
            raise Red(f"Realtime did not subscribe ({' '.join(line) or 'no output'})")
        sent = time.time()
        start = time.perf_counter()
        first = self.http.post(f"{self.api}/submissions", json=self.live_body(client_id, device), headers=self.auth)
        first.raise_for_status()
        client, server = [ms(start)], [first.json()["timing_ms"]["total"]]
        event = node.stdout.readline().split()
        node.wait(timeout=30)
        if not event or event[0] != "event":
            raise Red(f"no Realtime event for the insert ({' '.join(event) or 'timeout'})")
        realtime = int(event[1]) - round(sent * 1000)
        for _ in range(4):
            start = time.perf_counter()
            r = self.http.post(f"{self.api}/submissions", json=self.live_body(f"preflight-{uuid.uuid4()}", device),
                               headers=self.auth)
            r.raise_for_status()
            client.append(ms(start))
            server.append(r.json()["timing_ms"]["total"])
        p50, server_p50 = statistics.median(client), statistics.median(server)
        detail = f"ingest p50 {p50:.0f} ms round trip ({server_p50:.0f} ms in the API), n=5 · Realtime {realtime} ms"
        if judge and (p50 > 1500 or realtime > 5000):
            raise Red(detail + " (slow)")
        return detail, {"client_ms": client, "server_ms": server, "realtime_ms": realtime}

    def voice_end_to_end(self):
        """A phone interview with the voice-note fixture: upload, ingest, then the transcript and the model's verdict."""
        client_id = f"preflight-voice-{uuid.uuid4()}"
        device = f"phone-preflight{uuid.uuid4().hex[:8]}"
        start = time.perf_counter()
        signed = self.http.post(f"{self.api}/collect/upload", headers=self.auth, json={
            "device_id": device, "client_submission_id": client_id, "content_type": "audio/wav"}).raise_for_status().json()
        self.http.put(signed["upload_url"], content=VOICE_NOTE.read_bytes(),
                      headers={"content-type": "audio/wav", "x-upsert": "true"}).raise_for_status()
        body = self.live_body(client_id, device, voice_note_path=signed["path"])
        stored = self.http.post(f"{self.api}/submissions", json=body, headers=self.auth).raise_for_status().json()
        rules = time.perf_counter() - start
        transcript_at = verdict_at = None
        verdict = None
        while time.perf_counter() - start < 60:
            detail = self.http.get(f"{self.api}/submissions/{stored['id']}").raise_for_status().json()
            if transcript_at is None and detail["submission"].get("voice_transcript"):
                transcript_at = time.perf_counter() - start
            vff = next((c for c in detail["checks"] if c["key"] == "voice_vs_form"), None)
            if vff and vff["evidence"].get("decided_by") == "ai":
                verdict_at, verdict = time.perf_counter() - start, vff
                break
            time.sleep(1)
        if transcript_at is None:
            raise Red("no transcript within 60 s (ElevenLabs, the job hook or the cron sweep)")
        if verdict is None:
            raise Red(f"transcript at {transcript_at:.1f} s, but no model verdict within 60 s")
        said = "contradiction" if verdict["fired"] else "no contradiction"
        detail = (f"rules {rules:.1f} s · transcript {transcript_at:.1f} s (Scribe) · verdict {verdict_at:.1f} s "
                  f"(Claude: {said}, {round(verdict['evidence']['confidence'] * 100)}%)")
        if not verdict["fired"]:
            raise Red(detail + "; expected a contradiction")
        return detail, {"rules_s": rules, "transcript_s": transcript_at, "verdict_s": verdict_at}

    def warm(self):
        # /evaluate as the detectors page asks it (with the threshold sweep); /landing asks without one.
        calls = {"/overview": ("GET", None), "/map": ("GET", None), "/evaluate": ("POST", {"params": {}, "sweep": True}),
                 "/landing": ("GET", None), "/brief": ("GET", None)}
        times = {}
        for path, (method, body) in calls.items():
            runs = []
            for _ in range(2):
                start = time.perf_counter()
                self.http.request(method, f"{self.api}{path}", json=body).raise_for_status()
                runs.append(ms(start))
            times[path] = runs
        brief = self.http.get(f"{self.api}/brief").json()
        slow = [p for p, (_, second) in times.items() if second > 2000]
        detail = " · ".join(f"{p} {a}→{b} ms" for p, (a, b) in times.items())
        state = (brief.get("brief") or {}).get("status")
        detail += f" · brief: {state or 'none'}{' (being written)' if brief.get('writing') else ''}"
        if slow:
            raise Red(detail + f"; slow when warm: {', '.join(slow)}")
        return detail, times

    def reset(self):
        start = time.perf_counter()
        r = self.http.post(f"{self.api}/demo/reset", headers=self.auth, timeout=180).raise_for_status().json()
        return (f"removed {r['deleted']['submissions']} live submissions, {r['rescored']['flagged']} flagged · "
                f"{ms(start)} ms"), r

    def verify_wave(self):
        run = subprocess.run(["uv", "run", "scripts/verify_wave.py"], cwd=ROOT, capture_output=True, text=True)
        last = [line for line in run.stdout.strip().splitlines() if line][-1:] or ["no output"]
        if run.returncode != 0:
            raise Red(f"{last[0]} ({run.stderr.strip().splitlines()[-1] if run.stderr.strip() else 'see verify_wave.py'})")
        fresh = next((line for line in run.stdout.splitlines() if line.startswith("fresh wave")), "")
        return f"{last[0]} ({fresh.removeprefix('fresh wave: ')})", None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--base", default=os.environ.get("PREFLIGHT_BASE_URL", PROD))
    args = parser.parse_args()
    env = load_env(ROOT / ".env.local") if (ROOT / ".env.local").exists() else {}
    env = {**env, **{k: v for k, v in os.environ.items() if k in ("DEMO_PASSCODE", "SUPABASE_SERVICE_ROLE_KEY")}}
    if not env.get("DEMO_PASSCODE"):
        print("DEMO_PASSCODE is not set (.env.local)", file=sys.stderr)
        return 2

    started = time.perf_counter()
    print(f"preflight against {args.base} · {datetime.now().strftime('%Y-%m-%d %H:%M')}\n")
    p = Preflight(args.base, env)
    p.check("network path", p.network)
    p.check("production health", p.health)
    p.check("basemap tile host", p.tiles)
    p.check("collect token", p.collect_token)
    p.check("ingest + Realtime", p.ingest_and_realtime)
    p.check("voice note → AI verdict", p.voice_end_to_end)
    p.check("warm caches", p.warm)
    p.check("demo reset", p.reset)
    p.check("verify_wave", p.verify_wave)
    reds = [name for ok, name, _ in p.results if not ok]
    took = time.perf_counter() - started
    print(f"\n{GREEN + 'all green' + END if not reds else RED + f'{len(reds)} red: ' + ', '.join(reds) + END}"
          f" {DIM}· {took:.0f} s{END}")
    return 1 if reds else 0


if __name__ == "__main__":
    sys.exit(main())
