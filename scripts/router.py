#!/usr/bin/env python3
"""router — assign open tasks to a lane that can actually see them. DRY RUN BY DEFAULT.

THE DEFECT THIS EXISTS FOR
--------------------------
Measured on the live board 2026-08-06:

    OPEN tasks: 88      UNASSIGNED: 78
    operator cycles run: 2455
    tasks picked up by a lane: 0

Every worker driver filters `task_list` to `assignee_agent_id == its own` +
`status=open` (see scripts/tech-grok-worker.py:173). So a task with no assignee is
invisible to every lane, forever. The operator ran 2455 cycles, each lane truthfully
reported `cycle ok`, and nothing moved — the machine works perfectly and does nothing.

Nothing in the fleet assigns work. That is the whole gap. Routines generate tasks,
humans create tasks, and they all land unassigned and sit.

WHY DRY RUN IS THE DEFAULT, AND NOT A COURTESY
----------------------------------------------
Assignment decides what every agent in the fleet does. Getting it wrong does not
produce an error — it produces 78 confidently-misrouted tasks and a lot of expensive
motion in the wrong direction. So the first version prints its reasoning and writes
nothing; a human reads one cycle of that output before `--apply` is ever used.

Same discipline as the board-hygiene pass: propose, show the reasoning, then write.

CONSERVATIVE BY CONSTRUCTION
----------------------------
A task is routed ONLY on a clear signal. Everything else is reported UNROUTED with the
reason, because "I do not know where this goes" is a useful answer and a wrong guess is
not. A router that assigns everything is worse than one that assigns half and says so:
the unrouted list is the human's queue, and hiding it inside a bad assignment loses it.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

POT = os.environ.get("MUPOT_URL", "https://mupot.mumega.com")
TOKEN_PATHS = ("~/.fleet/agents/kasra-agent.token", "~/.fleet/agents/kasra-admin.token")
SQUAD = os.environ.get("ROUTER_SQUAD", "squad-core")

# The lanes, and the agent id each driver actually filters on. These ids are the
# contract — a task assigned to anything else is still invisible.
LANES = {
    "tech-grok": {
        "agent_id": "141e954c-115c-45dc-918e-b02931317b9b",
        "does": "code changes in an isolated worktree; runs tsc/tests; opens a PR",
        "keywords": (
            "fix", "bug", "test", "ci", "migration", "refactor", "typecheck", "guard",
            "gate", "regression", "schema", "endpoint", "route", "worker", "defect",
        ),
    },
    "mumcp": {
        "agent_id": "e6695da3-2e04-45b8-b4af-acddaa7c1438",
        "does": "WordPress work via MCPWP; writes are server-forced DRAFT",
        "keywords": ("wordpress", "wp", "elementor", "woocommerce", "mcpwp", "page", "post", "seo"),
    },
    "prime": {
        "agent_id": "e211b0fb-6ebf-4aab-bac5-6129ce6075e0",
        "does": "read-only audits, verification with receipts, docs; strong at scoped questions",
        "keywords": (
            "audit", "verify", "verification", "inventory", "docs", "documentation",
            "readme", "review the", "report", "investigate", "reconcile", "triage",
        ),
    },
}

# Words that mean a human decides, whatever else the title says. Checked FIRST, because
# a title can easily contain "fix" AND be a decision nobody delegated.
HUMAN_ONLY = (
    "decide", "decision", "countersign", "approve", "approval", "policy", "strategy",
    "pricing", "hire", "budget", "legal", "contract", "owner", "mint", "revoke",
    "credential", "token", "secret", "deploy", "production", "incident",
)


def _clean(t: str) -> str:
    return re.sub(r"^\[preset:[a-z]*\]\s*", "", t.strip())


def _token() -> str:
    explicit = os.environ.get("ROUTER_TOKEN", "").strip()
    if explicit:
        return _clean(explicit)
    for p in TOKEN_PATHS:
        f = Path(p).expanduser()
        try:
            if f.is_file():
                tok = _clean(f.read_text())
                if tok:
                    return tok
        except OSError:
            continue
    return ""


def call(tool: str, args: dict) -> dict:
    tok = _token()
    if not tok:
        raise RuntimeError("router: no pot token available")
    req = urllib.request.Request(
        f"{POT}/actions/{tool}",
        data=json.dumps(args).encode(),
        method="POST",
        headers={
            "Authorization": f"Bearer {tok}",
            "content-type": "application/json",
            # Cloudflare's bot rule rejects the default Python-urllib agent with 403
            # code 1010 before the request reaches the pot (mupot#718).
            "user-agent": "mupot-router/1.0 (+https://mupot.mumega.com)",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            payload = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode()[:200]
        except Exception:  # noqa: BLE001
            pass
        raise RuntimeError(f"{tool}: HTTP {e.code} {detail}") from e
    if not payload.get("ok", True):
        raise RuntimeError(f"{tool}: {json.dumps(payload.get('error'))[:200]}")
    return payload.get("result") or {}


# A GitHub webhook mirror is a NOTIFICATION, not work. Measured on the live board:
# 76 of 89 unassigned tasks were `[GH <repo>] PR #<n> <action>: …` rows, and the first
# dry run would have routed ~40 of them to the build lane.
#
# I reported that observation in this PR as evidence the dry run works — and did not
# guard it. Athena's gate caught that: observing a misroute is not preventing one, and
# --apply would still have done it. The guard belongs in the code, not in the commentary.
GH_MIRROR_RE = re.compile(r"^\[GH [^\]]+\] PR #\d+ ")


def route(task: dict) -> tuple[str | None, str]:
    """(lane_name | None, reason). None means a human decides — say why."""
    title = task.get("title", "")
    if GH_MIRROR_RE.match(title):
        return None, "GitHub PR mirror — a notification, not work; never route these to a lane"
    text = f"{title} {task.get('body','')}".lower()

    for w in HUMAN_ONLY:
        if w in text:
            return None, f"human-only signal {w!r} — decisions, credentials and deploys are not delegated"

    # WORD BOUNDARIES, not substrings. `k in text` matched 'ci' inside 'circuit',
    # 'fix' inside 'Prefix', and 'page' inside unrelated prose — every one of those
    # silently votes for a lane. A substring match is a confident wrong answer, which
    # is the most expensive kind here because the task then gets picked up and worked.
    hits: list[tuple[int, str, list[str]]] = []
    for name, lane in LANES.items():
        matched = [k for k in lane["keywords"]
                   if re.search(rf"(?<![a-z0-9]){re.escape(k)}(?![a-z0-9])", text)]
        if matched:
            hits.append((len(matched), name, matched))

    if not hits:
        return None, "no lane keyword matched — needs a human to classify or a better title"

    hits.sort(reverse=True)
    top, second = hits[0], (hits[1] if len(hits) > 1 else None)
    # An ambiguous task is a human's call, not a coin flip. Misrouting is silent and
    # expensive; asking is neither.
    if second and second[0] == top[0]:
        return None, f"ambiguous — {top[1]} and {second[1]} match equally ({top[2]} vs {second[2]})"
    return top[1], f"matched {top[2]}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true",
                    help="actually assign. Default is a dry run that writes nothing.")
    ap.add_argument("--limit", type=int, default=int(os.environ.get("ROUTER_LIMIT", "200")))
    ap.add_argument("--max-assign", type=int, default=int(os.environ.get("ROUTER_MAX_ASSIGN", "5")),
                    help="cap on writes per run, so a bad rule cannot rewrite the whole board")
    args = ap.parse_args()

    tasks = (call("task_list", {"squad_id": SQUAD, "status": "open", "limit": args.limit})
             .get("tasks") or [])
    unassigned = [t for t in tasks if not t.get("assignee_agent_id")]

    print(f"open={len(tasks)}  unassigned={len(unassigned)}  mode={'APPLY' if args.apply else 'DRY RUN'}")
    if not unassigned:
        print("nothing to route")
        return 0

    proposals: list[tuple[dict, str, str]] = []
    unrouted: list[tuple[dict, str]] = []
    for t in unassigned:
        lane, why = route(t)
        (proposals.append((t, lane, why)) if lane else unrouted.append((t, why)))

    print(f"\nROUTABLE ({len(proposals)}):")
    for t, lane, why in proposals[:40]:
        print(f"  {t['id'][:8]}  -> {lane:10s}  {t.get('title','')[:58]}")
        print(f"            {why}")

    print(f"\nUNROUTED ({len(unrouted)}) — a human decides, and this list is the point:")
    for t, why in unrouted[:25]:
        print(f"  {t['id'][:8]}  {t.get('title','')[:58]}")
        print(f"            {why}")
    if len(unrouted) > 25:
        print(f"  … and {len(unrouted) - 25} more")

    if not args.apply:
        print("\nDRY RUN — nothing written. Re-run with --apply to assign the ROUTABLE set.")
        return 0

    # Capped, and the cap is not a formality: a wrong rule applied to 78 tasks is a lot
    # of confident motion in the wrong direction, and every one would then be picked up.
    todo = proposals[: args.max_assign]
    print(f"\nAPPLYING {len(todo)} of {len(proposals)} (cap {args.max_assign}):")
    for t, lane, _ in todo:
        aid = LANES[lane]["agent_id"]
        try:
            call("task_update", {"task_id": t["id"], "assignee_agent_id": aid})
            print(f"  assigned {t['id'][:8]} -> {lane}")
        except RuntimeError as e:
            # Report, never swallow: a failed assignment that looks like success is how
            # this fleet lost 167 refusals in a log nobody read.
            print(f"  FAILED   {t['id'][:8]} -> {lane}: {e}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
