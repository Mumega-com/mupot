#!/usr/bin/env python3
"""One-time backfill: close GitHub PR-mirror tasks whose PR is already closed.

WHY THIS IS A BACKFILL AND NOT A FIX
------------------------------------
The production closer already exists and is already wired:
`src/integrations/github-routes.ts:359` calls `closeGitHubPrMirrorTasks` on
`action === 'closed'`. The mechanism is correct going forward.

What is left is history: PRs that closed BEFORE that code shipped never got swept, so
their mirror tasks are still `open`. Measured on the live board 2026-08-06:

    open + unassigned:       89
      GitHub event mirrors:  76   (85%)
      real work items:       13

85% of the visible backlog is webhook exhaust burying 13 things that matter. That is why
every triage attempt drowns and why the board reads as hopeless.

SAFETY
------
- Closes ONLY a task whose title matches `[GH <repo>] PR #<n> ` AND whose PR is verified
  closed on GitHub right now. The PR state is the authority, not the task's age or title.
- Never touches a task with a gate_owner or a project_id — the same exclusions the
  production closer uses, so this cannot sweep gated or project-attached work.
- Goes through the task API, never raw D1 (product path, house rule).
- Dry run by default.

`open -> done` is refused by the transition matrix, so each close walks
open -> in_progress -> done. That is two writes per task and it is deliberate: the state
machine is the same one every other actor obeys, and bypassing it here to save a call
would make this script the one thing on the board that does not.
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

POT = os.environ.get("MUPOT_URL", "https://mupot.mumega.com")
SQUAD = os.environ.get("SWEEP_SQUAD", "squad-core")
TOKEN_PATHS = ("~/.fleet/agents/kasra-agent.token", "~/.fleet/agents/kasra-admin.token")
TITLE_RE = re.compile(r"^\[GH (?P<repo>[^\]]+)\] PR #(?P<num>\d+) (?P<action>\w+)")


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
        f"{POT}/actions/{tool}", data=json.dumps(args).encode(), method="POST",
        headers={
            "Authorization": f"Bearer {_token()}",
            "content-type": "application/json",
            "user-agent": "mupot-sweep/1.0",  # urllib's default UA is 403'd (mupot#718)
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
    """'OPEN' | 'CLOSED' | 'MERGED', or None when it cannot be determined.

    None is NOT treated as closed anywhere below. An unreadable PR must never be a
    reason to close a task — that is the cannot-verify-is-not-pass rule, and this script
    is exactly the kind of bulk actor where getting it wrong is expensive and quiet.
    """
    key = (repo, num)
    if key in _pr_cache:
        return _pr_cache[key]
    env = {**os.environ}
    env.pop("GITHUB_TOKEN", None)  # gh token env-shadow guard
    try:
        out = subprocess.run(
            ["gh", "pr", "view", num, "--repo", repo, "--json", "state", "-q", ".state"],
            capture_output=True, text=True, timeout=30, env=env,
        )
        state = out.stdout.strip().upper() if out.returncode == 0 else None
    except Exception:  # noqa: BLE001
        state = None
    _pr_cache[key] = state
    return state


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="actually close. Default: dry run.")
    ap.add_argument("--limit", type=int, default=300)
    args = ap.parse_args()

    tasks = (call("task_list", {"squad_id": SQUAD, "status": "open", "limit": args.limit})
             .get("tasks") or [])
    mirrors = []
    for t in tasks:
        m = TITLE_RE.match(t.get("title", ""))
        if not m:
            continue
        if t.get("gate_owner") or t.get("project_id"):
            continue  # same exclusions the production closer applies
        mirrors.append((t, m.group("repo"), m.group("num"), m.group("action")))

    print(f"open={len(tasks)}  gh-mirror candidates={len(mirrors)}  "
          f"mode={'APPLY' if args.apply else 'DRY RUN'}")

    closable, keep, unknown = [], [], []
    for t, repo, num, action in mirrors:
        st = pr_state(repo, num)
        if st is None:
            unknown.append((t, repo, num, "PR state unreadable — NOT closing"))
        elif st in ("CLOSED", "MERGED"):
            closable.append((t, repo, num, st))
        else:
            keep.append((t, repo, num, st))

    print(f"\nCLOSABLE ({len(closable)}) — PR verified closed/merged on GitHub:")
    for t, repo, num, st in closable[:15]:
        print(f"  {t['id'][:8]}  {repo}#{num} {st:6s}  {t.get('title','')[:52]}")
    if len(closable) > 15:
        print(f"  … and {len(closable) - 15} more")

    print(f"\nKEEPING ({len(keep)}) — PR still OPEN, the task is arguably live:")
    for t, repo, num, st in keep[:10]:
        print(f"  {t['id'][:8]}  {repo}#{num} {st}")

    if unknown:
        print(f"\nUNKNOWN ({len(unknown)}) — left alone, deliberately:")
        for t, repo, num, why in unknown[:10]:
            print(f"  {t['id'][:8]}  {repo}#{num}  {why}")

    if not args.apply:
        print("\nDRY RUN — nothing written. Re-run with --apply.")
        return 0

    ok = fail = 0
    for t, repo, num, st in closable:
        tid = t["id"]
        try:
            # open -> in_progress -> done: the transition matrix refuses open -> done.
            call("task_update", {"task_id": tid, "status": "in_progress"})
            call("task_update", {"task_id": tid, "status": "done"})
            ok += 1
        except RuntimeError as e:
            fail += 1
            print(f"  FAILED {tid[:8]} {repo}#{num}: {e}")
    print(f"\nclosed={ok}  failed={fail}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
