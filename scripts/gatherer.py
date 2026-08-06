#!/usr/bin/env python3
"""gatherer — the noticing pass. Reads state, ranks anomalies, changes nothing.

WHY THIS EXISTS
---------------
On 2026-08-06 every defect in the fleet was found because a human asked a
question. Nothing noticed anything on its own:

  - all five EXECUTOR seats were dead; the executor roster was empty
  - 167 HTTP 401s in six hours, visible only in one service's access log
  - Redis logging `invalid username-password pair` on a continuous loop
  - routines parking in `queued` forever with no alert (mupot#732)
  - tasks sitting in `review` for days with no verdict
  - a merged, deployed fix that was inert (mupot#734)

Each was individually cheap to see and collectively invisible, because the
system had observability without *noticing*. That is the industry's canonical
2026 anti-pattern — "observability-as-logging" — and the fix is the dead man's
switch: absence of a healthy signal is itself the alert.

THREE RULES, each paid for by a specific past failure
-----------------------------------------------------
1. READ ONLY. No task_update, no verdict, no dispatch, no merge. The gatherer
   reports; humans and gates decide. A noticing loop that also acts becomes the
   act-loop that spammed this fleet before.

2. RANK, DO NOT ACT — and be IDEMPOTENT. Same state must produce the same
   digest. That is what makes it safe to run every cycle forever: an unchanged
   problem does not generate new noise, it keeps appearing in the same place
   with a longer age.

3. ONE DIGEST PER CYCLE, not one alert per event. The last thing this fleet
   needs is another Telegram spam emitter. Notification is OFF by default and
   flag-gated; the digest goes to the operator log where the other lanes write.

WATCHING THE WATCHER
--------------------
A watcher that fails the way the thing it watches fails is not a watcher. Two
guards: the gatherer stamps a heartbeat file every run (so its own silence is
detectable), and it reports its own last-run age in the digest. If the digest
says the previous run was 3 hours ago on a 5-minute loop, the gatherer itself is
the finding.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

POT = os.environ.get("MUPOT_URL", "https://mupot.mumega.com")
TOKEN_PATHS = (
    "~/.fleet/agents/kasra-agent.token",
    "~/.fleet/agents/kasra-admin.token",
)
STATE = Path(os.environ.get("GATHERER_STATE", "~/.fleet/gatherer")).expanduser()
HEARTBEAT = STATE / "last-run.json"

# Thresholds. Deliberately generous — a gatherer that cries at 5 minutes teaches
# people to ignore it, which is the failure mode that costs the most.
REVIEW_STALE_H = int(os.environ.get("GATHERER_REVIEW_STALE_H", "12"))
INPROGRESS_STALE_H = int(os.environ.get("GATHERER_INPROGRESS_STALE_H", "24"))
RUN_STUCK_MIN = int(os.environ.get("GATHERER_RUN_STUCK_MIN", "60"))
# The loop's own cadence, used only to judge whether the LAST gatherer run is
# stale. 3x the operator interval, so one skipped cycle is not a finding.
SELF_STALE_S = int(os.environ.get("OPERATOR_INTERVAL", "300")) * 3


def _clean(tok: str) -> str:
    return re.sub(r"^\[preset:[a-z]*\]\s*", "", tok.strip())


def _token() -> str:
    """File first, ambient env last.

    Same ordering lesson as sovereign/kernel/workers_ai.py, learned the same day:
    an exported token on this host was stale while the credential file was good,
    and env-first authenticated as the dead one. A 401 then reads as "revoked"
    when the real fault is the SOURCE.
    """
    explicit = os.environ.get("GATHERER_TOKEN", "").strip()
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


def call(tool: str, args: dict | None = None) -> dict:
    """POST /actions/<tool>. Raises on transport or API failure — never returns
    a shape the caller could mistake for 'nothing to report'.

    This is the whole point. `if status == 200: ...` with no else is exactly how
    167 refusals looked identical to an idle fleet.
    """
    tok = _token()
    if not tok:
        raise RuntimeError("gatherer: no pot token available")
    req = urllib.request.Request(
        f"{POT}/actions/{tool}",
        data=json.dumps(args or {}).encode(),
        method="POST",
        headers={
            "Authorization": f"Bearer {tok}",
            "content-type": "application/json",
            # REQUIRED, and it is not cosmetic. Cloudflare's bot-signature rule
            # rejects the default `Python-urllib/3.x` agent with HTTP 403 code
            # 1010 BEFORE the request reaches the pot — so an unauthenticated-
            # looking failure is really an edge block, and no token change fixes
            # it. Reproduced 2026-08-06 building this script; this is almost
            # certainly mupot#718 ("WAF blocks /actions/:tool"), which had no
            # repro until now: curl is allowed, urllib is not.
            "user-agent": "mupot-gatherer/1.0 (+https://mupot.mumega.com)",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            payload = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode()[:200]
        except Exception:  # noqa: BLE001 — diagnostic only
            pass
        raise RuntimeError(f"{tool}: HTTP {e.code} {detail}") from e
    if not payload.get("ok", True):
        raise RuntimeError(f"{tool}: {json.dumps(payload.get('error'))[:200]}")
    return payload.get("result") or {}


def _age_h(stamp: str | None) -> float | None:
    if not stamp:
        return None
    s = stamp.strip().replace(" ", "T")
    if not s.endswith("Z") and "+" not in s[10:]:
        s += "Z"
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    return (datetime.now(timezone.utc) - dt).total_seconds() / 3600.0


# ── findings ────────────────────────────────────────────────────────────────
# Each check returns a list of (severity, text). Severity orders the digest;
# it does NOT trigger anything. Ranking is the product.

SEV = {"P0": 0, "P1": 1, "P2": 2}


def check_self(findings: list[tuple[str, str]]) -> None:
    """The gatherer's own dead man's switch."""
    try:
        prev = json.loads(HEARTBEAT.read_text())
        gap = time.time() - float(prev.get("ts", 0))
    except Exception:  # noqa: BLE001 — first run, or corrupt state
        return
    if gap > SELF_STALE_S:
        findings.append((
            "P1",
            f"GATHERER ITSELF was silent for {gap/60:.0f}m "
            f"(expected every {SELF_STALE_S/60:.0f}m or better) — the watcher stopped watching",
        ))


def check_board(findings: list[tuple[str, str]]) -> None:
    board = call("task_list", {"squad_id": "squad-core", "limit": 200})
    tasks = board.get("tasks") or []

    stale_review = [
        t for t in tasks
        if t.get("status") == "review" and (_age_h(t.get("updated_at")) or 0) > REVIEW_STALE_H
    ]
    if stale_review:
        oldest = max((_age_h(t.get("updated_at")) or 0) for t in stale_review)
        findings.append((
            "P1",
            f"{len(stale_review)} task(s) in REVIEW with no verdict, oldest {oldest:.0f}h "
            f"— work is finished and nobody is gating it: "
            + ", ".join(t["id"][:8] for t in stale_review[:6]),
        ))

    stalled = [
        t for t in tasks
        if t.get("status") == "in_progress"
        and (_age_h(t.get("updated_at")) or 0) > INPROGRESS_STALE_H
    ]
    if stalled:
        findings.append((
            "P2",
            f"{len(stalled)} task(s) IN_PROGRESS with no update for >{INPROGRESS_STALE_H}h "
            f"— a lane may have died mid-task: "
            + ", ".join(t["id"][:8] for t in stalled[:6]),
        ))

    unowned = [t for t in tasks if t.get("status") == "open" and not t.get("assignee_agent_id")]
    if len(unowned) > 20:
        findings.append((
            "P2",
            f"{len(unowned)} OPEN tasks with no assignee — the board is accumulating faster "
            f"than it is being triaged",
        ))


def check_presence(findings: list[tuple[str, str]]) -> None:
    """The #732 class: an agent can look registered and still be undispatchable."""
    peers = call("peers", {})
    agents = peers.get("agents") or peers.get("peers") or []
    active = [a for a in agents if a.get("status") == "active"]
    if not active:
        findings.append(("P0", "ZERO active agents in the pot roster — nothing can be dispatched"))
        return

    # presence is an OBJECT, not a string: {source, label, last_seen_at, liveness,
    # last_seen_human} with liveness in active|idle|dead|never.
    #
    # The first version of this check did `str(a.get("presence")).lower() == "live"`,
    # which can never match — and duly reported a P0 "NO agent reports presence=live"
    # against a fleet with two agents seen "just now". Caught by verifying the tool's
    # own finding against the raw API before believing it. Worth keeping the scar
    # visible: a gatherer that cries false P0s is worse than no gatherer, because it
    # trains everyone to ignore the real one.
    def liveness(a: dict) -> str:
        pres = a.get("presence")
        if isinstance(pres, dict):
            return str(pres.get("liveness", "")).lower()
        return str(pres or "").lower()

    live = [a for a in active if liveness(a) in ("active", "live")]
    if not live:
        findings.append((
            "P0",
            f"NO agent is live ({len(active)} active on the roster, none seen recently) — "
            f"every routine will park in queued/agent_offline with no other symptom "
            f"(mupot#732)",
        ))
    idle_only = [a for a in active if liveness(a) in ("dead", "never")]
    if len(idle_only) >= max(1, len(active) - 2):
        findings.append((
            "P2",
            f"{len(idle_only)}/{len(active)} roster agents have never checked in or are "
            f"long dead — the roster is mostly ghosts, which makes a real outage harder to see",
        ))


def check_routines(findings: list[tuple[str, str]]) -> None:
    """mupot#744: a stuck run wedges its routine with zero diagnostics."""
    try:
        # routine_list requires project_id; iterate the projects rather than
        # reporting a probe failure every cycle for a call shape we control.
        projects = call("project_list", {}).get("projects") or []
        routines = []
        for proj in projects:
            got = call("routine_list", {"project_id": proj["id"]}).get("routines") or []
            routines.extend(got)
    except RuntimeError as e:
        findings.append(("P2", f"could not read routines: {e}"))
        return
    enabled = [r for r in routines if r.get("status") == "enabled"]
    if not enabled:
        return
    stuck: list[str] = []
    for r in enabled:
        try:
            runs = call("routine_run_list", {"routine_id": r["id"], "limit": 5}).get("runs") or []
        except RuntimeError:
            continue
        for run in runs:
            if run.get("status") in ("queued", "leased", "observing", "waiting"):
                mins = (_age_h(run.get("updated_at")) or 0) * 60
                if mins > RUN_STUCK_MIN:
                    stuck.append(f"{r.get('key', r['id'][:8])}/{run['id'][:8]} {mins:.0f}m")
    if stuck:
        findings.append((
            "P1",
            f"{len(stuck)} routine run(s) stuck >{RUN_STUCK_MIN}m and wedging their routine "
            f"(mupot#744): " + ", ".join(stuck[:6]),
        ))


CHECKS = (check_self, check_board, check_presence, check_routines)


def main() -> int:
    STATE.mkdir(parents=True, exist_ok=True)
    findings: list[tuple[str, str]] = []
    broken: list[str] = []

    for check in CHECKS:
        try:
            check(findings)
        except Exception as e:  # noqa: BLE001 — one broken probe must not blind the rest
            # A probe that cannot run is itself a finding. Swallowing it here
            # would rebuild the exact hole this whole script exists to close.
            broken.append(f"{check.__name__}: {e}")

    for b in broken:
        findings.append(("P1", f"PROBE FAILED — cannot verify this surface: {b}"))

    findings.sort(key=lambda f: SEV.get(f[0], 9))
    stamp = datetime.now(timezone.utc).strftime("%FT%TZ")

    if findings:
        print(f"[{stamp}] gatherer: {len(findings)} finding(s)")
        for sev, text in findings:
            print(f"[{stamp}] gatherer:   {sev} {text}")
    else:
        print(f"[{stamp}] gatherer: clear ({len(CHECKS)} checks, nothing to report)")

    HEARTBEAT.write_text(json.dumps({
        "ts": time.time(),
        "at": stamp,
        "findings": len(findings),
        "checks": len(CHECKS),
    }))

    # Notification is OFF unless explicitly enabled, and only for P0. This fleet
    # has produced Telegram spam emitters before; a digest in the operator log is
    # the default and a page is the exception.
    if os.environ.get("GATHERER_NOTIFY") == "1":
        p0 = [t for s, t in findings if s == "P0"]
        if p0:
            notify = Path("~/scripts/notify-hadi.sh").expanduser()
            if notify.is_file():
                subprocess.run(
                    [str(notify), "gatherer P0:\n" + "\n".join(p0[:3])],
                    check=False, timeout=30,
                )

    # Exit 0 even with findings: findings are the PRODUCT, not an error. A
    # non-zero exit would make run_driver log "cycle exited 1" and bury the
    # digest under a false failure.
    return 0


if __name__ == "__main__":
    sys.exit(main())
