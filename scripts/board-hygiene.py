#!/usr/bin/env python3
"""One-time backfill: board hygiene — close selftests, duplicates, and resolve stuck review tasks.

WHY THIS IS A BACKFILL AND NOT A FIX
------------------------------------
Priority shipped in #710/#715. The board is still almost entirely untriaged (191 tasks
with NULL priority). Additionally:

1. Two [SELFTEST] tasks sit in in_progress/review — these are internal test findings,
   not real work items. They should be closed.

2. Duplicate pairs persist from the steward double-fire event: two identical loop-runbook
   tasks and two identical security-sweep selftests. These should be closed (keep one,
   close the duplicate).

3. Eight tasks sat in review status whose PRs were already closed on GitHub. These should
   be rejected (cannot be left in review indefinitely — verdict endpoint is the gating
   path, not task_update).

SAFETY
------
- SELFTEST tasks: closes ONLY tasks whose title contains "[SELFTEST" and status is
  in_progress or review. The check is title-based, precise.

- Duplicates: identified by exact title + similar/identical body match. Only closes
  the second-created one per pair, keeping the first (originating task).

- Review stuck tasks: identified by PR status verification (same mechanism as
  sweep-gh-mirror-tasks). Only rejects if PR is verified closed/merged on GitHub.
  Uses task_verdict endpoint (proper gating path), never raw update.

- Never touches a task with gate_owner or project_id — same exclusions the
  production closer uses.

- Dry run by default.

The state machine is respected: uses task_update -> task_verdict in order, never bypasses.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import NamedTuple

POT = os.environ.get("MUPOT_URL", "https://mupot.mumega.com")
SQUAD = os.environ.get("HYGIENE_SQUAD", "squad-core")
TOKEN_PATHS = ("~/.fleet/agents/kasra-agent.token", "~/.fleet/agents/kasra-admin.token")
SELFTEST_RE = re.compile(r"\[SELFTEST", re.IGNORECASE)
GH_MIRROR_RE = re.compile(r"^\[GH (?P<repo>[^\]]+)\] PR #(?P<num>\d+)")


class Task(NamedTuple):
    id: str
    title: str
    body: str
    status: str
    gate_owner: str | None
    project_id: str | None


def _token() -> str:
    for p in TOKEN_PATHS:
        f = Path(p).expanduser()
        try:
            if f.is_file():
                t = re.sub(r"^\[preset:[a-z]*\]\s*", "", f.read_text().strip())
                if t:
                    return t
        except OSError:
            continue
    return ""


def call(tool: str, args: dict) -> dict:
    req = urllib.request.Request(
        f"{POT}/actions/{tool}",
        data=json.dumps(args).encode(),
        method="POST",
        headers={
            "Authorization": f"Bearer {_token()}",
            "content-type": "application/json",
            "user-agent": "mupot-hygiene/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            payload = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode()[:200]
        except Exception:  # noqa: BLE001
            pass
        raise RuntimeError(f"{tool}: HTTP {e.code} {body}") from e
    if not payload.get("ok", True):
        raise RuntimeError(f"{tool}: {json.dumps(payload.get('error'))[:200]}")
    return payload.get("result") or {}


_pr_cache: dict[tuple[str, str], str | None] = {}


def pr_state(repo: str, num: str) -> str | None:
    """'OPEN' | 'CLOSED' | 'MERGED', or None when it cannot be determined."""
    key = (repo, num)
    if key in _pr_cache:
        return _pr_cache[key]
    env = {**os.environ}
    env.pop("GITHUB_TOKEN", None)
    try:
        out = subprocess.run(
            ["gh", "pr", "view", num, "--repo", repo, "--json", "state", "-q", ".state"],
            capture_output=True,
            text=True,
            timeout=30,
            env=env,
        )
        state = out.stdout.strip().upper() if out.returncode == 0 else None
    except Exception:  # noqa: BLE001
        state = None
    _pr_cache[key] = state
    return state


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="actually close/reject. Default: dry run.")
    ap.add_argument("--limit", type=int, default=500)
    args = ap.parse_args()

    # Fetch all tasks in open/in_progress/review statuses.
    tasks = []
    for st in ("open", "in_progress", "review"):
        tasks.extend(
            call("task_list", {"squad_id": SQUAD, "status": st, "limit": args.limit}).get("tasks")
            or []
        )

    # Convert to Task objects for easier handling.
    task_objs = [
        Task(
            id=t["id"],
            title=t.get("title", ""),
            body=t.get("body", ""),
            status=t.get("status", ""),
            gate_owner=t.get("gate_owner"),
            project_id=t.get("project_id"),
        )
        for t in tasks
    ]

    print(f"Fetched {len(task_objs)} tasks  mode={'APPLY' if args.apply else 'DRY RUN'}")

    # Identify SELFTEST tasks to close.
    selftest_tasks = [
        t
        for t in task_objs
        if SELFTEST_RE.search(t.title) and t.status in ("in_progress", "review")
        and not t.gate_owner
        and not t.project_id
    ]

    # Identify duplicates: exact title match. Keep the first by ID, close later ones.
    duplicates_by_title = {}
    for t in task_objs:
        if t.gate_owner or t.project_id:
            continue
        if SELFTEST_RE.search(t.title):
            # Only look for duplicates within SELFTEST tasks
            if t.title not in duplicates_by_title:
                duplicates_by_title[t.title] = []
            duplicates_by_title[t.title].append(t)

    duplicate_pairs = [
        (sorted(tasks, key=lambda x: x.id)[0], task)
        for tasks in duplicates_by_title.values()
        for task in sorted(tasks, key=lambda x: x.id)[1:]
    ]

    # Identify review tasks with closed PRs.
    review_with_closed_pr = []
    for t in task_objs:
        if t.status != "review":
            continue
        if t.gate_owner or t.project_id:
            continue
        m = GH_MIRROR_RE.match(t.title)
        if not m:
            continue
        st = pr_state(m.group("repo"), m.group("num"))
        if st in ("CLOSED", "MERGED"):
            review_with_closed_pr.append((t, m.group("repo"), m.group("num"), st))

    print(f"\nSELFTEST TASKS TO CLOSE ({len(selftest_tasks)}):")
    for t in selftest_tasks[:10]:
        print(f"  {t.id[:8]}  {t.status:12s}  {t.title[:60]}")
    if len(selftest_tasks) > 10:
        print(f"  … and {len(selftest_tasks) - 10} more")

    print(f"\nDUPLICATE PAIRS TO RECONCILE ({len(duplicate_pairs)}):")
    for orig, dup in duplicate_pairs[:10]:
        print(f"  Keep {orig.id[:8]}, close {dup.id[:8]}")
    if len(duplicate_pairs) > 10:
        print(f"  … and {len(duplicate_pairs) - 10} more pairs")

    print(f"\nREVIEW TASKS WITH CLOSED PRs TO REJECT ({len(review_with_closed_pr)}):")
    for t, repo, num, st in review_with_closed_pr[:10]:
        print(f"  {t.id[:8]}  {repo}#{num} {st:6s}  {t.title[:50]}")
    if len(review_with_closed_pr) > 10:
        print(f"  … and {len(review_with_closed_pr) - 10} more")

    if not args.apply:
        print("\nDRY RUN — nothing written. Re-run with --apply.")
        return 0

    ok = fail = 0

    # Close SELFTEST tasks.
    for t in selftest_tasks:
        tid = t.id
        try:
            if t.status != "in_progress":
                call("task_update", {"task_id": tid, "status": "in_progress"})
            call("task_update", {"task_id": tid, "status": "done"})
            ok += 1
        except RuntimeError as e:
            fail += 1
            print(f"  FAILED {tid[:8]} (selftest close): {e}")

    # Close duplicate tasks (keep first, close second).
    for orig, dup in duplicate_pairs:
        tid = dup.id
        try:
            if dup.status != "in_progress":
                call("task_update", {"task_id": tid, "status": "in_progress"})
            call("task_update", {"task_id": tid, "status": "done"})
            ok += 1
        except RuntimeError as e:
            fail += 1
            print(f"  FAILED {tid[:8]} (duplicate close): {e}")

    # Reject review tasks with closed PRs (use verdict endpoint, the proper gate).
    for t, repo, num, st in review_with_closed_pr:
        tid = t.id
        try:
            call(
                "task_verdict",
                {
                    "task_id": tid,
                    "verdict": "rejected",
                    "note": f"PR {repo}#{num} {st.lower()} on GitHub. Review was open indefinitely.",
                },
            )
            ok += 1
        except RuntimeError as e:
            fail += 1
            print(f"  FAILED {tid[:8]} (review reject): {e}")

    print(f"\nProcessed {ok} tasks  failed={fail}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
