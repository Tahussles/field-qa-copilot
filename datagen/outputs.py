"""Local outputs: submissions.csv, truth.csv, summary.json and preview.png."""

import csv
import hashlib
import json
from collections import Counter
from pathlib import Path

from . import config as cfg
from .wave import Wave

NOISE_KINDS = (
    "short_genuine",
    "straightline_genuine",
    "two_source_transcript",
    "compound_cluster",
    "late_capture",
    "late_sync",
)

FRAUD_STYLE = {  # colour, marker
    "curbstone": ("#d62728", "s"),
    "speeder": ("#ff7f0e", "^"),
    "copypaste": ("#9467bd", "D"),
    "contradiction": ("#8c564b", "v"),
    "night": ("#1f77b4", "*"),
    "multi_account": ("#e377c2", "P"),
    "burst": ("#2ca02c", "X"),
}


def rows_sha256(rows: dict[str, list[dict]]) -> str:
    blob = json.dumps(rows, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(blob.encode()).hexdigest()


def summarize(wave: Wave, rows: dict[str, list[dict]]) -> dict:
    subs = wave.submissions
    fabricated = Counter(s.fraud_type for s in subs if s.is_fabricated)
    noise = Counter(n for s in subs for n in s.noise)

    def actor(label: str, fraud_type: str, picked: list) -> dict:
        return {
            "actor": label,
            "fraud_type": fraud_type,
            "total": len(picked),
            "fabricated": sum(s.fraud_type == fraud_type for s in picked),
        }

    actors = [
        actor(code, fraud_type, [s for s in subs if s.contributor.code == code])
        for code, fraud_type in cfg.FRAUD_ENUMERATORS.items()
    ]
    ring = actor(f"device {wave.ring_device}", "multi_account",
                 [s for s in subs if s.device_id == wave.ring_device])
    ring["accounts"] = wave.ring_members
    actors.append(ring)
    actors.append(actor(wave.burst_account, "burst", [s for s in subs if s.contributor.code == wave.burst_account]))

    return {
        "seed": wave.seed,
        "project_id": wave.project["id"],
        "project": f"{wave.project['name']} (wave {cfg.WAVE}, {wave.project['region']})",
        "fieldwork": [wave.project["start_date"], wave.project["end_date"]],
        "submissions": {
            "total": len(subs),
            "enumerator": sum(s.contributor.kind == "enumerator" for s in subs),
            "participant": sum(s.contributor.kind == "participant" for s in subs),
        },
        "fabricated": {
            "total": sum(fabricated.values()),
            "share_pct": round(100 * sum(fabricated.values()) / len(subs), 2),
            "by_type": {t: fabricated.get(t, 0) for t in cfg.FRAUD_TYPES},
        },
        "genuine_noise": {k: noise.get(k, 0) for k in NOISE_KINDS},
        "fraud_actors": actors,
        "rows_sha256": rows_sha256(rows),
    }


def write_local(wave: Wave, rows: dict[str, list[dict]], summary: dict, out_dir: Path) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    by_id = {s.id: s for s in wave.submissions}

    submissions_csv = out_dir / "submissions.csv"
    with submissions_csv.open("w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow([
            "id", "client_submission_id", "contributor_code", "contributor_kind", "area", "device_id",
            "captured_at", "captured_at_eat", "synced_at", "duration_sec", "lat", "lng", "gps_accuracy_m",
            "water_source", "satisfaction", "open_text", "voice_transcript", "transcript_lang", "source",
        ])
        for row in rows["submissions"]:
            sub = by_id[row["id"]]
            writer.writerow([
                row["id"], row["client_submission_id"], sub.contributor.code, sub.contributor.kind,
                sub.contributor.area.name, row["device_id"], row["captured_at"],
                sub.captured_at.astimezone(cfg.EAT).isoformat(), row["synced_at"], row["duration_sec"],
                row["lat"], row["lng"], row["gps_accuracy_m"], row["answers"]["water_source"],
                json.dumps(row["answers"]["satisfaction"]), row["answers"]["open_text"],
                row["voice_transcript"], row["transcript_lang"], row["source"],
            ])

    truth_csv = out_dir / "truth.csv"
    with truth_csv.open("w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["submission_id", "contributor_code", "device_id", "is_fabricated", "fraud_type", "noise"])
        for sub in wave.submissions:
            writer.writerow([sub.id, sub.contributor.code, sub.device_id, sub.is_fabricated,
                             sub.fraud_type or "", ";".join(sub.noise)])

    summary_json = out_dir / "summary.json"
    summary_json.write_text(json.dumps(summary, indent=2) + "\n")

    preview_png = out_dir / "preview.png"
    plot_preview(wave, summary, preview_png)
    return [submissions_csv, truth_csv, summary_json, preview_png]


def plot_preview(wave: Wave, summary: dict, path: Path) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(12, 7.6))
    for area in wave.areas:
        xs, ys = zip(*area.ring)
        ax.fill(xs, ys, color="#f3f1ea", zorder=0)
        ax.plot(xs, ys, color="#6b6b6b", linewidth=1, zorder=1)
        cx, cy = sum(xs[:-1]) / 4, sum(ys[:-1]) / 4
        ax.text(cx, max(ys) - 0.0012, area.name, ha="center", va="top", fontsize=10, color="#444", zorder=4)

    genuine = [s for s in wave.submissions if not s.is_fabricated]
    ax.scatter([s.point[0] for s in genuine], [s.point[1] for s in genuine], s=6, color="#9e9e9e",
               alpha=0.5, linewidths=0, label=f"genuine ({len(genuine)})", zorder=2)
    for fraud_type, (colour, marker) in FRAUD_STYLE.items():
        picked = [s for s in wave.submissions if s.fraud_type == fraud_type]
        ax.scatter([s.point[0] for s in picked], [s.point[1] for s in picked], s=46, color=colour,
                   marker=marker, edgecolors="black", linewidths=0.4,
                   label=f"{fraud_type} ({len(picked)})", zorder=3)

    fab = summary["fabricated"]
    ax.set_title(f"{cfg.PROJECT_NAME}, wave {cfg.WAVE} (synthetic, seed {wave.seed})\n"
                 f"{summary['submissions']['total']} submissions, {fab['total']} fabricated ({fab['share_pct']}%)")
    ax.set_xlabel("Longitude")
    ax.set_ylabel("Latitude")
    ax.set_aspect("equal")
    ax.legend(loc="upper left", bbox_to_anchor=(1.01, 1.0), frameon=False, title="truth")
    ax.text(1.01, 0.0, "Area boundaries are synthetic,\nnot official.", transform=ax.transAxes,
            fontsize=8, color="#666", va="bottom")
    fig.tight_layout()
    fig.savefig(path, dpi=150)
    plt.close(fig)
