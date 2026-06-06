#!/usr/bin/env python3
"""
generate_state.py — write docs/STATE.md, the single canonical "what's true
right now" snapshot for any agent or human reading the repo.

Synthesizes the outputs that already exist:
  - docs/ROADMAP.md          → current stage row
  - docs/decisions/*.md      → latest 7 days of operational decisions
  - docs/cost/summary.md     → last 30 days of provider $
  - docs/conformance/summary.md → cohesion scores per repo
  - docs/completion-tracker.json → overall completion + ci_red + smoke_red
  - docs/GAP_REGISTER.md     → open P0/P1 count + recent closes
  - gh pr list               → open PRs (oldest APPROVED first)

Read order:
  1. The pinned section (stage + operating mode) tells you where Factory is.
  2. The live-numbers section tells you what production looks like today.
  3. The follow-ups section tells you what's open.
  4. Read PLATFORM_STANDARDS.md, PATTERNS.md, FRIDGE.md for norms / rules.

This script is pure read + write. No HTTP for state extraction (it reads
files already on disk). The only network call is `gh pr list` for the
open-PR section, which is optional (--no-gh skips it).

Usage:
  python scripts/generate_state.py                  # write docs/STATE.md
  python scripts/generate_state.py --no-gh          # skip the gh PR list
  python scripts/generate_state.py --check          # exit 1 if STATE.md is out of date
  python scripts/generate_state.py --stdout         # print to stdout, no file write
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
DECISIONS_DIR = DOCS / "decisions"
STATE_PATH = DOCS / "STATE.md"
TRACKER_PATH = DOCS / "completion-tracker.json"
COST_SUMMARY = DOCS / "cost" / "summary.md"
CONFORMANCE_SUMMARY = DOCS / "conformance" / "summary.md"
ROADMAP = DOCS / "ROADMAP.md"
GAP_REGISTER = DOCS / "GAP_REGISTER.md"


# ───────────────────────── extractors ─────────────────────────

def extract_current_stage(roadmap_text: str) -> str:
    """Find the row in the status table whose Status column starts with anything
    other than `✅ shipped`, where it's `next` or `in flight`. Falls back to a
    one-liner if the table shape changes."""
    # Pattern: | **N — Title** | next |
    next_row = re.search(r"\|\s*\*\*(\d+\s+—\s+[^*]+)\*\*\s*\|\s*next\s*\|", roadmap_text)
    if next_row:
        return next_row.group(1).strip()
    in_flight = re.search(r"\|\s*\*\*(\d+\s+—\s+[^*]+)\*\*\s*\|\s*🔄|in flight", roadmap_text, re.IGNORECASE)
    if in_flight:
        return in_flight.group(1).strip()
    return "(parser couldn't find the next stage in ROADMAP.md — table shape changed?)"


def extract_latest_decisions(limit: int = 7) -> list[dict[str, str]]:
    """Read docs/decisions/*.md (excluding README), parse frontmatter, return
    newest-first by date in frontmatter."""
    if not DECISIONS_DIR.exists():
        return []
    out: list[dict[str, str]] = []
    for p in DECISIONS_DIR.glob("*.md"):
        if p.name.lower() == "readme.md":
            continue
        text = p.read_text(encoding="utf-8", errors="replace")
        meta = _parse_frontmatter(text)
        if not meta.get("date"):
            continue
        title_match = re.search(r"^#\s+(.+?)\s*$", text, re.MULTILINE)
        out.append({
            "date": meta.get("date", ""),
            "status": meta.get("status", ""),
            "decider": meta.get("decider", ""),
            "title": title_match.group(1) if title_match else p.stem,
            "path": str(p.relative_to(ROOT)).replace("\\", "/"),
        })
    out.sort(key=lambda d: d["date"], reverse=True)
    return out[:limit]


def _parse_frontmatter(text: str) -> dict[str, str]:
    """Minimal YAML frontmatter parser (string values only). Returns {} on miss."""
    if not text.startswith("---\n"):
        return {}
    end = text.find("\n---\n", 4)
    if end < 0:
        return {}
    block = text[4:end]
    meta: dict[str, str] = {}
    for line in block.splitlines():
        line = line.strip()
        if not line or ":" not in line:
            continue
        k, v = line.split(":", 1)
        meta[k.strip()] = v.strip().strip("'\"")
    return meta


def extract_tracker() -> dict[str, Any]:
    """Read completion-tracker.json. Returns {} if absent."""
    if not TRACKER_PATH.exists():
        return {}
    try:
        return json.loads(TRACKER_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def classify_tracker(tracker: dict[str, Any], now: datetime) -> tuple[bool, str]:
    """Return (usable, reason) for completion-tracker data.

    The completion tracker can fail by producing an all-zero snapshot. STATE.md
    must not present that as live truth. A tracker is usable only when it has
    row data and is fresh enough to trust as an operating signal.
    """
    if not tracker:
        return False, "docs/completion-tracker.json not present"

    generated_raw = str(tracker.get("generated_at") or "").strip()
    rows = tracker.get("rows") or []
    repo_weighted = tracker.get("repo_weighted") or {}

    if not rows:
        return False, f"snapshot has no rows (generated {generated_raw or '?'})"

    if generated_raw:
        try:
            generated_at = datetime.fromisoformat(generated_raw.replace("Z", "+00:00"))
            if generated_at.tzinfo is None:
                generated_at = generated_at.replace(tzinfo=timezone.utc)
            age_hours = (now.astimezone(timezone.utc) - generated_at.astimezone(timezone.utc)).total_seconds() / 3600
            if age_hours > 48:
                return False, f"snapshot is stale ({age_hours:.0f}h old, generated {generated_raw[:19]})"
        except Exception:
            return False, f"snapshot generated_at is unparsable ({generated_raw})"

    if repo_weighted and all(float(value or 0) == 0 for value in repo_weighted.values()):
        return False, f"snapshot reports all repo weights as 0 despite being present (generated {generated_raw[:19] or '?'})"

    return True, "usable"


def extract_conformance() -> str | None:
    """Read the per-repo summary table from docs/conformance/summary.md. Returns
    the table section as markdown, or None if missing."""
    if not CONFORMANCE_SUMMARY.exists():
        return None
    text = CONFORMANCE_SUMMARY.read_text(encoding="utf-8", errors="replace")
    # Find the cohesion summary table specifically (heading "## Cohesion summary"
    # if present, otherwise the first table)
    m = re.search(r"## Cohesion summary\s*\n(.*?)(?=\n## |\Z)", text, re.DOTALL)
    if m:
        return m.group(1).strip()
    # Fallback — first markdown table
    rows = []
    in_table = False
    for line in text.splitlines():
        if line.startswith("|"):
            rows.append(line)
            in_table = True
        elif in_table:
            break
    return "\n".join(rows) if rows else None


def extract_cost_today() -> str | None:
    """Read latest day's totals from docs/cost/summary.md (provider totals table
    and the most-recent daily row)."""
    if not COST_SUMMARY.exists():
        return None
    text = COST_SUMMARY.read_text(encoding="utf-8", errors="replace")
    # Provider totals section
    pt = re.search(r"## Provider totals \(window\)\s*\n+(\|[^\n]+\n[-|:\s]+\n(?:\|[^\n]+\n)+)", text)
    block = pt.group(1).strip() if pt else None
    return block


def extract_gap_counts() -> dict[str, int]:
    """Count P0/P1/P2/P3 open + in-progress + closed rows from GAP_REGISTER.md."""
    counts = {"P0_open": 0, "P0_inprogress": 0, "P1_open": 0, "P1_inprogress": 0,
              "P2_open": 0, "P3_open": 0, "closed_total": 0}
    if not GAP_REGISTER.exists():
        return counts
    text = GAP_REGISTER.read_text(encoding="utf-8", errors="replace")
    # Sections delimited by `## P0` / `## P1` / etc.
    section_map = {
        "P0": ("P0_open", "P0_inprogress"),
        "P1": ("P1_open", "P1_inprogress"),
        "P2": ("P2_open", "P2_open"),       # P2/P3 we just count "open"
        "P3": ("P3_open", "P3_open"),
    }
    current_section: str | None = None
    for line in text.splitlines():
        sh = re.match(r"^##\s+(P[0-3])\b", line)
        if sh:
            current_section = sh.group(1)
            continue
        # Table rows: "| Gx | ... | status | ... |"
        if not line.startswith("| G") or current_section not in section_map:
            continue
        # Look for status keyword in any cell. The status cell convention has
        # **closed**, open, **in-progress**, partial, **partial**.
        if re.search(r"\*?\*?(in-progress|partial)\*?\*?", line, re.IGNORECASE):
            counts[section_map[current_section][1]] += 1
        elif re.search(r"\*?\*?closed\*?\*?", line, re.IGNORECASE):
            counts["closed_total"] += 1
        elif re.search(r"\bopen\b", line, re.IGNORECASE) and "wontfix" not in line.lower():
            counts[section_map[current_section][0]] += 1
    return counts


def list_open_prs(limit: int = 10) -> list[dict[str, Any]] | None:
    """Best-effort open-PR list via `gh pr list`. Returns None if gh isn't
    available or auth fails (so the script doesn't break when run locally
    without auth)."""
    try:
        result = subprocess.run(
            ["gh", "pr", "list", "--state", "open", "--limit", "30",
             "--repo", "Latimer-Woods-Tech/Factory",
             "--json", "number,title,createdAt,reviewDecision,isDraft,labels"],
            capture_output=True, text=True, timeout=20, check=False,
        )
        if result.returncode != 0:
            return None
        prs = json.loads(result.stdout)
    except (subprocess.SubprocessError, json.JSONDecodeError, FileNotFoundError):
        return None
    # APPROVED + non-draft first, oldest first
    approved = sorted(
        [p for p in prs if p.get("reviewDecision") == "APPROVED" and not p.get("isDraft")],
        key=lambda p: p["createdAt"],
    )
    return approved[:limit]


# ───────────────────────── renderer ─────────────────────────

def render(now: datetime) -> str:
    stage = extract_current_stage(ROADMAP.read_text(encoding="utf-8") if ROADMAP.exists() else "")
    tracker = extract_tracker()
    cost_block = extract_cost_today()
    conformance_block = extract_conformance()
    gaps = extract_gap_counts()
    decisions = extract_latest_decisions(7)
    prs = list_open_prs(10)

    lines: list[str] = []
    lines.append(f"# Factory State — {now.strftime('%Y-%m-%d')}")
    lines.append("")
    lines.append(
        "*Auto-generated by `scripts/generate_state.py`. Single canonical "
        "\"what's true right now\" snapshot — read this first when picking up "
        "work or onboarding an agent.*"
    )
    lines.append("")
    lines.append(f"*Generated: {now.strftime('%Y-%m-%dT%H:%M:%SZ')}*")
    lines.append("")

    lines.append("## Where Factory is")
    lines.append("")
    lines.append(f"**Current stage:** {stage}")
    lines.append("")
    lines.append("**Standing reads** (in priority order):")
    lines.append("1. [`docs/supervisor/FRIDGE.md`](./supervisor/FRIDGE.md) — non-negotiable operating rules")
    lines.append("2. [`docs/ROADMAP.md`](./ROADMAP.md) — full stage sequence + exit criteria")
    lines.append("3. [`docs/PLATFORM_STANDARDS.md`](./PLATFORM_STANDARDS.md) — what we build (norms)")
    lines.append("4. [`docs/architecture/PATTERNS.md`](./architecture/PATTERNS.md) — how we build (operational know-how)")
    lines.append("5. [`docs/decisions/`](./decisions/) — recent operational decisions (see below)")
    lines.append("6. [`docs/GAP_REGISTER.md`](./GAP_REGISTER.md) — known debt")
    lines.append("")

    lines.append("## Live numbers")
    lines.append("")
    tracker_usable, tracker_reason = classify_tracker(tracker, now)
    if tracker_usable:
        weighted = tracker.get("overall_weighted")
        known = tracker.get("overall_known")
        raw = tracker.get("overall_raw")
        ci_red = tracker.get("ci_red") or []
        smoke_red = tracker.get("smoke_red") or []
        gen = tracker.get("generated_at", "?")
        lines.append(f"**Completion (from `completion-tracker.json`, generated {gen[:19]}):**")
        lines.append("")
        if weighted is not None:
            lines.append(f"- Overall weighted: **{weighted:.1f}%**")
        if known is not None:
            lines.append(f"- Overall known: {known:.1f}%")
        if raw is not None:
            lines.append(f"- Overall raw: {raw:.1f}%")
        rw = tracker.get("repo_weighted") or {}
        if rw:
            lines.append(f"- Per-repo weighted: " + ", ".join(f"{k}={v:.1f}%" for k, v in rw.items()))
        if ci_red:
            lines.append(f"- CI red: {', '.join(ci_red)}")
        if smoke_red:
            lines.append(f"- Smoke red: {', '.join(smoke_red)}")
        lines.append("")
    else:
        lines.append("**Completion:** not currently trusted.")
        lines.append("")
        lines.append(f"- Reason: {tracker_reason}.")
        lines.append("- Action: repair `completion-tracker.yml` / `scripts/aggregate_completion.py`, or remove completion tracker from operating decisions until it emits non-empty fresh rows.")
        lines.append("")

    if conformance_block:
        lines.append("**Cohesion (from `docs/conformance/summary.md`):**")
        lines.append("")
        lines.append(conformance_block)
        lines.append("")

    if cost_block:
        lines.append("**Cost (from `docs/cost/summary.md` — rolling 30-day window):**")
        lines.append("")
        lines.append(cost_block)
        lines.append("")

    lines.append("## Open follow-up debt")
    lines.append("")
    lines.append(
        f"- **P0 open:** {gaps['P0_open']}  ·  in-progress: {gaps['P0_inprogress']}"
    )
    lines.append(
        f"- **P1 open:** {gaps['P1_open']}  ·  in-progress: {gaps['P1_inprogress']}"
    )
    lines.append(f"- **P2 open:** {gaps['P2_open']}")
    lines.append(f"- **P3 open:** {gaps['P3_open']}")
    lines.append(f"- **Closed in register total:** {gaps['closed_total']}")
    lines.append("")
    lines.append("See [`docs/GAP_REGISTER.md`](./GAP_REGISTER.md) for line-by-line.")
    lines.append("")

    lines.append("## Recent decisions")
    lines.append("")
    if decisions:
        lines.append("| Date | Status | Title | Path |")
        lines.append("|---|---|---|---|")
        for d in decisions:
            lines.append(f"| {d['date']} | {d['status']} | {d['title']} | [`{d['path']}`](./{d['path'].split('/', 1)[1] if '/' in d['path'] else d['path']}) |")
    else:
        lines.append("*(No decisions logged in `docs/decisions/` yet.)*")
    lines.append("")

    if prs is not None:
        lines.append("## Oldest APPROVED open PRs (top 10)")
        lines.append("")
        if prs:
            lines.append("| # | Age | Title |")
            lines.append("|---|----:|---|")
            for p in prs:
                created = datetime.fromisoformat(p["createdAt"].replace("Z", "+00:00"))
                age_d = (now - created).days
                title = p["title"]
                if len(title) > 80:
                    title = title[:77] + "..."
                lines.append(f"| [#{p['number']}](https://github.com/Latimer-Woods-Tech/Factory/pull/{p['number']}) | {age_d}d | {title} |")
        else:
            lines.append("*(No APPROVED non-draft PRs sitting open. )*")
        lines.append("")
    else:
        lines.append("## Oldest APPROVED open PRs")
        lines.append("")
        lines.append("*(skipped — `gh` not available or auth failed during generation)*")
        lines.append("")

    lines.append("---")
    lines.append("")
    lines.append(
        "*This file is auto-generated. Do not edit by hand — your edit will be "
        "overwritten on the next run. To change what's surfaced, modify "
        "[`scripts/generate_state.py`](../scripts/generate_state.py).*"
    )
    return "\n".join(lines) + "\n"


# ───────────────────────── CLI ─────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description="Generate docs/STATE.md")
    ap.add_argument("--check", action="store_true",
                    help="exit 1 if STATE.md is out of date vs. what we'd generate")
    ap.add_argument("--stdout", action="store_true",
                    help="print to stdout, don't write to file")
    ap.add_argument("--no-gh", action="store_true",
                    help="skip the open-PR list (no network call)")
    args = ap.parse_args()

    if args.no_gh:
        global list_open_prs
        list_open_prs = lambda limit=10: None  # type: ignore

    now = datetime.now(timezone.utc).replace(microsecond=0)
    content = render(now)

    if args.stdout:
        sys.stdout.write(content)
        return 0

    if args.check:
        if not STATE_PATH.exists():
            print(f"STATE.md missing", file=sys.stderr)
            return 1
        current = STATE_PATH.read_text(encoding="utf-8")
        # Strip the timestamp line so check doesn't flap on every minute
        norm = lambda s: re.sub(r"\*Generated:.*?\*\n", "", s)
        if norm(current) == norm(content):
            print("STATE.md is up to date")
            return 0
        print("STATE.md is out of date — run `python scripts/generate_state.py`", file=sys.stderr)
        return 1

    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(content, encoding="utf-8")
    print(f"Wrote {STATE_PATH.relative_to(ROOT)} ({len(content)} chars)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
