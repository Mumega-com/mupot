#!/usr/bin/env python3
"""Headless GATE driver -- diverse adversarial review of mupot loop PRs.

Closes the last hands-on gap in the standing operator (scripts/operator-loop.sh):
cursor-worker.py and mumcp-worker.py already build on isolated worktrees, push,
open a PR, and move the task to `review` with `gate_owner=gate:kasra-core` --
they CANNOT self-close (mupot no-self-close guard, PR #417). Until now a human
(Kasra-core) read every PR by hand. This driver runs the DIVERSE adversarial eye
(Claude, a different vendor+model from cursor's Grok) headlessly every cycle and
posts a recommended verdict as an audit receipt on the task. It never grants
itself a new capability: review-only by default, auto-merge exists but is
flag-gated OFF, and every path fails CLOSED (parks the task, never merges) on
any ambiguity or error.

Verified live before writing this (2026-07-21, kasra-code, read-only D1 query):
  - gate_owner 'gate:kasra-core' has exactly ONE holder capable of task_verdict:
    member 14136dec-5062-bf0a-832c-1765bad314fa (kasra@agents.mumega.com).
    ~/.fleet/agents/kasra-member.token IS that member's token (confirmed via a
    live task_list call -- NOT agent-bound, so squad_id must be passed
    explicitly; an agent-bound token would infer it from the bound agent).
  - The `cursor` agent's own squad_id IS 'squad-core' (Core Platform) -- the
    SAME squad Kasra/kasra-member sits in. Every cursor-worker PR review task
    therefore already lands in a squad this token can read/write without any
    new grant. mumcp-worker's tasks live in a different squad (MCPWP Core) but
    carry no `PR: <url>` in their body (mumcp writes WordPress drafts, not
    PRs) -- this driver's own PR-link filter naturally skips them, so no
    cross-squad polling is needed for this driver's scope.

Flow per cycle:
  1. poll        -> task_list(squad_id, status=review), client-filter to
                    gate_owner==GATE_OWNER and a `PR: <url>` in the body (the
                    exact format cursor-worker.py writes in report_review()).
  2. dedupe      -> skip a task whose body already carries a
                    `review-worker -> <head sha>:` receipt for the PR's
                    CURRENT head sha (already reviewed this head; re-pushes
                    get re-reviewed since the sha changes).
  3. classify    -> `gh pr diff --name-only`; ANY changed path matching the
                    sensitive-surface regex (migrations/, auth*, identity,
                    reputation, gate, eligib*, verdict, grant, token, secret,
                    rbac, scim/saml/oidc/oauth, webhook, external) marks the
                    PR sensitive=true. No changed files reported at all is
                    ALSO sensitive=true (conservative: unclassifiable -> sensitive).
  4. review      -> `claude -p --tools ""` (a DIFFERENT vendor+model from
                    cursor's Grok -- the cross-vendor diverse eye) in a bare
                    scratch cwd (no project .mcp.json/CLAUDE.md/tools -- zero
                    ambient authority, it only ever sees the diff text handed
                    to it) reads the real PR diff, hunts P0/P1/WARN findings,
                    verifies the PR's own claims against the diff, and must
                    return STRICT JSON `{"verdict","p0","p1","warn","summary"}`.
                    Any parse failure, timeout, or non-GREEN/RED verdict value
                    is treated as verdict=RED (fail-closed).
  5. act         -> ALWAYS: append a `review-worker -> <sha>: ...` receipt to
                    the task body (audit trail) + best-effort bus-notify kasra.
                    REVIEW_AUTOMERGE=0 (default, shipping default): stop here
                    -- task stays in `review` for Kasra-core to task_verdict.
                    REVIEW_AUTOMERGE=1 (off by default): only when ALL of
                    verdict==GREEN, p0 and p1 both empty, sensitive==false,
                    `gh pr view` reports mergeable==MERGEABLE, statusCheckRollup
                    is non-empty and every check green, AND the repo is the
                    hardcoded canonical Mumega-com/mupot -- task_verdict
                    (approved) then `gh pr merge --squash --delete-branch`.
                    Any unmet condition or exception -> park + notify, never
                    merge. This driver NEVER runs `npm run deploy`, an install,
                    or a service restart -- merge-to-main is its absolute
                    ceiling, and only behind the flag.
  6. idle-safe   -> zero review tasks in the squad = a read-only no-op cycle.

Config (env):
  MUPOT_MCP          default https://mupot.mumega.com/mcp
  REVIEW_TOKEN       default ~/.fleet/agents/kasra-member.token (holds
                     gate:kasra-core as a MEMBER grant -- see verified note above)
  REVIEW_SQUAD_ID    default 'squad-core' (cursor's + kasra's squad; required
                     because kasra-member.token is not agent-bound)
  GATE_OWNER         default 'gate:kasra-core'
  REPO_SLUG          default 'Mumega-com/mupot' (overridable for testing; the
                     auto-merge repo guard always compares against the
                     hardcoded canonical slug, not this variable, so an
                     accidental REPO_SLUG override cannot widen the merge blast
                     radius)
  REVIEW_AUTOMERGE   '1' enables the auto-merge path (default '0' -- OFF)
  MAX_REVIEWS        default 1 (tasks actually reviewed per cycle)
  TIMEOUT            default 900 (seconds for the claude -p adversarial run)
  MODEL              default 'opus' (a stronger, different-model eye than the
                     Sonnet that built this driver; override freely)
  CLAUDE_BIN         default 'claude'
  WORKTREE_ROOT      default /home/mumega/mupot-worktrees (only used for a
                     throwaway 'review-scratch' cwd -- this driver never
                     creates a git worktree of its own)
  DRY_RUN            '1' = poll + classify + print what would be reviewed,
                     make ZERO mcp/gh mutating calls, never dispatch claude

Usage:
  python3 scripts/review-worker.py            # one-shot, up to MAX_REVIEWS
  DRY_RUN=1 python3 scripts/review-worker.py  # show what it would review
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

MUPOT_MCP = os.environ.get("MUPOT_MCP", "https://mupot.mumega.com/mcp")
REVIEW_TOKEN_PATH = Path(os.environ.get("REVIEW_TOKEN", str(Path.home() / ".fleet/agents/kasra-member.token")))
REVIEW_SQUAD_ID = os.environ.get("REVIEW_SQUAD_ID", "squad-core")
GATE_OWNER = os.environ.get("GATE_OWNER", "gate:kasra-core")
REPO_SLUG = os.environ.get("REPO_SLUG", "Mumega-com/mupot")
CANONICAL_REPO_SLUG = "Mumega-com/mupot"  # auto-merge guard always checks THIS, not REPO_SLUG
REVIEW_AUTOMERGE = os.environ.get("REVIEW_AUTOMERGE", "0") == "1"
MAX_REVIEWS = int(os.environ.get("MAX_REVIEWS", "1"))
TIMEOUT = int(os.environ.get("TIMEOUT", "900"))
MODEL = os.environ.get("MODEL", "opus")
CLAUDE_BIN = os.environ.get("CLAUDE_BIN", "claude")
WORKTREE_ROOT = Path(os.environ.get("WORKTREE_ROOT", "/home/mumega/mupot-worktrees"))
DRY_RUN = os.environ.get("DRY_RUN", "") == "1"

DIFF_MAX_CHARS = 150_000
PR_URL_RE = re.compile(r"PR:\s*(https://\S+)")
PR_NUM_RE = re.compile(r"/pull/(\d+)")
SENSITIVE_PATH_RE = re.compile(
    r"(^|/)migrations/"
    r"|auth"
    r"|identity"
    r"|reputation"
    r"|gate"
    r"|eligib"
    r"|verdict"
    r"|grant"
    r"|token"
    r"|secret"
    r"|rbac"
    r"|scim"
    r"|saml"
    r"|oidc"
    r"|oauth"
    r"|webhook"
    r"|external",
    re.IGNORECASE,
)


def log(msg: str) -> None:
    print(f"[review-worker] {msg}", flush=True)


def token() -> str:
    return REVIEW_TOKEN_PATH.read_text().strip()


def mcp(tool: str, args: dict) -> dict:
    """Call a mupot MCP tool as the review-worker's bound member. Returns the tool's `result`."""
    body = json.dumps(
        {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": tool, "arguments": args}}
    ).encode()
    req = urllib.request.Request(
        MUPOT_MCP,
        data=body,
        headers={
            "Authorization": f"Bearer {token()}",
            "content-type": "application/json",
            # CF error 1010 blocks the default Python-urllib UA as a bot signature.
            "User-Agent": "review-worker/1.0 (+mupot)",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        payload = json.loads(resp.read())
    if "error" in payload:
        raise RuntimeError(f"mupot {tool} error: {payload['error']}")
    inner = json.loads(payload["result"]["content"][0]["text"])
    if not inner.get("ok", True):
        raise RuntimeError(f"mupot {tool} not ok: {inner}")
    return inner.get("result", inner)


def gh(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env.pop("GITHUB_TOKEN", None)  # gh token shadow guard (reference_gh_token_fix)
    return subprocess.run(["gh", *args], env=env, check=check, capture_output=True, text=True)


def poll_review_tasks() -> list[dict]:
    res = mcp("task_list", {"squad_id": REVIEW_SQUAD_ID, "status": "review", "limit": max(25, MAX_REVIEWS * 10)})
    return res.get("tasks", [])


def extract_pr_url(body: str) -> str | None:
    m = PR_URL_RE.search(body or "")
    if not m:
        return None
    return m.group(1).rstrip(".,)")


def extract_pr_number(url: str) -> int | None:
    m = PR_NUM_RE.search(url)
    return int(m.group(1)) if m else None


def fetch_pr_meta(pr_number: int) -> dict:
    out = gh(
        "pr", "view", str(pr_number), "--repo", REPO_SLUG, "--json",
        "number,url,title,body,headRefOid,mergeable,statusCheckRollup,state",
    )
    return json.loads(out.stdout)


def fetch_changed_files(pr_number: int) -> list[str]:
    out = gh("pr", "diff", str(pr_number), "--repo", REPO_SLUG, "--name-only")
    return [line.strip() for line in out.stdout.splitlines() if line.strip()]


def fetch_diff(pr_number: int) -> str:
    out = gh("pr", "diff", str(pr_number), "--repo", REPO_SLUG)
    text = out.stdout or ""
    if len(text) > DIFF_MAX_CHARS:
        text = (
            text[:DIFF_MAX_CHARS]
            + f"\n\n... [diff truncated at {DIFF_MAX_CHARS} chars -- treat anything past "
            "this point as unverified, and say so in the summary] ..."
        )
    return text


def classify_sensitive(files: list[str]) -> tuple[bool, str]:
    if not files:
        return True, "no changed files reported by gh -- unclassifiable, fail-closed to sensitive"
    hits = [f for f in files if SENSITIVE_PATH_RE.search(f)]
    if hits:
        return True, f"sensitive-surface path match: {hits[:5]}"
    return False, "no sensitive-surface path match"


def already_reviewed(body: str, head_sha: str) -> bool:
    return f"review-worker -> {head_sha}:" in (body or "")


def build_review_prompt(pr_meta: dict, diff_text: str, sensitive: bool, sensitive_reason: str) -> str:
    return "\n".join(
        [
            "You are an ADVERSARIAL code reviewer -- the diverse cross-vendor gate on a",
            "different model+vendor than the PR's author (a Grok/Cursor agent). Your job is",
            "to hunt for bugs, not to be agreeable. Verify the PR's own claims in its title/",
            "body against what the diff ACTUALLY does -- a claim with no matching diff change",
            "is itself a finding. Do not rubber-stamp; do not fabricate a pass with no real",
            "analysis.",
            "",
            f"PR #{pr_meta.get('number')} in {REPO_SLUG} -- {pr_meta.get('title', '')}",
            f"head sha: {pr_meta.get('headRefOid', '')}",
            f"sensitive-surface flag (pre-classified by the driver, informational only): "
            f"{sensitive} ({sensitive_reason})",
            "",
            "PR description:",
            (pr_meta.get("body") or "")[:4000],
            "",
            "DIFF:",
            diff_text or "(no diff content retrieved -- treat as unreviewable and say so)",
            "",
            "Classify findings as:",
            "  P0 -- blocking: security vulnerability, data loss, self-poisoning/gameable",
            "        gate, broken auth/authz, or a correctness bug that breaks the stated",
            "        behavior.",
            "  P1 -- significant but not blocking: real bug or design flaw; fix before merge",
            "        recommended but not an emergency.",
            "  WARN -- lower severity: style, missing test, minor edge case.",
            "",
            "Respond with STRICT JSON ONLY -- no markdown fences, no commentary before or",
            "after -- exactly this shape:",
            '{"verdict": "GREEN"|"RED", "p0": ["..."], "p1": ["..."], "warn": ["..."], "summary": "one paragraph"}',
            "",
            "verdict MUST be RED if p0 is non-empty. GREEN requires zero p0 AND zero p1.",
            "Do not execute any code or use any tools -- you have none available -- reason",
            "only over the diff text above.",
        ]
    )


def run_claude_review(prompt: str) -> subprocess.CompletedProcess:
    scratch = WORKTREE_ROOT / "review-scratch"
    scratch.mkdir(parents=True, exist_ok=True)
    cmd = [CLAUDE_BIN, "-p", "--output-format", "json", "--model", MODEL, "--tools", ""]
    log(f"dispatching adversarial review ({CLAUDE_BIN} --model {MODEL}, timeout {TIMEOUT}s, zero tools, neutral scratch cwd) ...")
    return subprocess.run(cmd, input=prompt, cwd=str(scratch), capture_output=True, text=True, timeout=TIMEOUT)


def extract_claude_text(proc: subprocess.CompletedProcess) -> str:
    if proc.returncode != 0:
        log(f"claude exit {proc.returncode}: {(proc.stderr or '')[-500:]}")
    try:
        payload = json.loads(proc.stdout)
        return payload.get("result", "") or json.dumps(payload)
    except (json.JSONDecodeError, AttributeError):
        return proc.stdout or ""


def _normalize_verdict(obj: dict) -> dict:
    verdict = obj.get("verdict")
    if verdict not in ("GREEN", "RED"):
        return {
            "verdict": "RED",
            "p0": [f"invalid_verdict_value:{verdict!r} -- fail-closed"],
            "p1": [],
            "warn": [],
            "summary": obj.get("summary", "") if isinstance(obj.get("summary"), str) else "",
        }
    return {
        "verdict": verdict,
        "p0": obj["p0"] if isinstance(obj.get("p0"), list) else [],
        "p1": obj["p1"] if isinstance(obj.get("p1"), list) else [],
        "warn": obj["warn"] if isinstance(obj.get("warn"), list) else [],
        "summary": obj.get("summary", "") if isinstance(obj.get("summary"), str) else "",
    }


def parse_verdict(text: str) -> dict:
    """No fake green: an unparseable or malformed reviewer response is RED, never GREEN."""
    stripped = text.strip()
    candidates: list[str] = [stripped]
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", stripped, re.DOTALL)
    if fence:
        candidates.append(fence.group(1))
    start, end = stripped.find("{"), stripped.rfind("}")
    if start != -1 and end > start:
        candidates.append(stripped[start : end + 1])

    for candidate in candidates:
        try:
            obj = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict) and "verdict" in obj:
            return _normalize_verdict(obj)

    return {
        "verdict": "RED",
        "p0": ["parse_failure: adversarial reviewer output was not valid JSON -- fail-closed"],
        "p1": [],
        "warn": [],
        "summary": f"PARSE_FAILURE. raw tail: {stripped[-500:]}",
    }


def checks_green(rollup: object) -> bool:
    if not isinstance(rollup, list) or len(rollup) == 0:
        return False  # no CI configured / unknown -- conservative: not green
    for check in rollup:
        if not isinstance(check, dict):
            return False
        conclusion = str(check.get("conclusion") or "").upper()
        state = str(check.get("state") or "").upper()
        ok = conclusion in ("SUCCESS", "NEUTRAL", "SKIPPED") or state == "SUCCESS"
        if not ok:
            return False
    return True


def attempt_automerge(task: dict, pr_meta: dict, verdict_obj: dict, sensitive: bool) -> dict:
    if not REVIEW_AUTOMERGE:
        return {"attempted": False, "merged": False, "reason": "automerge disabled (REVIEW_AUTOMERGE=0, shipping default)"}
    try:
        if verdict_obj["verdict"] != "GREEN":
            return {"attempted": True, "merged": False, "reason": f"verdict={verdict_obj['verdict']}, not GREEN"}
        if verdict_obj["p0"] or verdict_obj["p1"]:
            return {"attempted": True, "merged": False, "reason": "non-empty p0/p1 findings"}
        if sensitive:
            return {"attempted": True, "merged": False, "reason": "sensitive-surface PR -- parked for human gate"}
        if pr_meta.get("mergeable") != "MERGEABLE":
            return {"attempted": True, "merged": False, "reason": f"pr not mergeable ({pr_meta.get('mergeable')})"}
        if not checks_green(pr_meta.get("statusCheckRollup")):
            return {"attempted": True, "merged": False, "reason": "CI checks not green or absent"}
        if REPO_SLUG != CANONICAL_REPO_SLUG:
            return {"attempted": True, "merged": False, "reason": f"repo guard: {REPO_SLUG} != {CANONICAL_REPO_SLUG}"}

        mcp(
            "task_verdict",
            {"task_id": task["id"], "verdict": "approved", "note": f"review-worker auto-verdict: {verdict_obj['summary']}"},
        )
        merge = gh("pr", "merge", str(pr_meta["number"]), "--repo", REPO_SLUG, "--squash", "--delete-branch", check=False)
        if merge.returncode != 0:
            return {
                "attempted": True,
                "merged": False,
                "reason": f"task_verdict approved but gh pr merge failed (task left approved, not merged): {merge.stderr[-500:]}",
            }
        return {"attempted": True, "merged": True, "reason": "auto-merged (GREEN, non-sensitive, mergeable, checks green)"}
    except Exception as exc:  # noqa: BLE001 - any exception here must park, never merge
        return {"attempted": True, "merged": False, "reason": f"exception during automerge, parked (fail-closed): {exc}"}


def build_receipt(head_sha: str, verdict_obj: dict, sensitive: bool, sensitive_reason: str, mode_note: str) -> str:
    lines = [
        f"review-worker -> {head_sha}: {verdict_obj['verdict']} "
        f"(p0={len(verdict_obj['p0'])} p1={len(verdict_obj['p1'])} warn={len(verdict_obj['warn'])}) "
        f"sensitive={sensitive} [{sensitive_reason}]",
        f"summary: {verdict_obj['summary']}",
    ]
    if verdict_obj["p0"]:
        lines.append("P0: " + "; ".join(str(x) for x in verdict_obj["p0"][:10]))
    if verdict_obj["p1"]:
        lines.append("P1: " + "; ".join(str(x) for x in verdict_obj["p1"][:10]))
    if verdict_obj["warn"]:
        lines.append("WARN: " + "; ".join(str(x) for x in verdict_obj["warn"][:10]))
    lines.append(mode_note)
    return "\n".join(lines)


def report_review(task: dict, head_sha: str, verdict_obj: dict, sensitive: bool, sensitive_reason: str, mode_note: str) -> None:
    receipt = build_receipt(head_sha, verdict_obj, sensitive, sensitive_reason, mode_note)
    body = f"{task.get('body', '')}\n\n---\n{receipt}"
    # Body-only update: this task is already in `review` and stays there in
    # review-only mode -- status is deliberately NOT touched here.
    mcp("task_update", {"task_id": task["id"], "body": body})


def notify_kasra(task: dict, pr_meta: dict, verdict_obj: dict, sensitive: bool, automerge_result: dict) -> None:
    """Best-effort bus ping so Kasra-core sees the recommended verdict. Non-fatal if it fails."""
    try:
        automerge_note = "merged" if automerge_result.get("merged") else automerge_result.get("reason", "review-only")
        msg = (
            f"review-worker: task {task['id'].split('-')[0]} PR #{pr_meta.get('number')} "
            f"verdict={verdict_obj['verdict']} sensitive={sensitive} "
            f"p0={len(verdict_obj['p0'])} p1={len(verdict_obj['p1'])} "
            f"automerge=[{automerge_note}] -- {pr_meta.get('url', '')}"
        )
        subprocess.run(
            ["python3", str(Path.home() / "scripts/bus-send.py"), "kasra", msg],
            capture_output=True, text=True, timeout=20,
        )
    except Exception as exc:  # noqa: BLE001 - notify is best-effort
        log(f"notify kasra failed (non-fatal): {exc}")


def process_task(task: dict) -> bool:
    """Returns True if this task counted against MAX_REVIEWS (was a real candidate),
    False if it was skipped (not ours, no PR, or already reviewed at this head)."""
    tid = task["id"]
    short = tid.split("-")[0]
    body = task.get("body", "") or ""

    if task.get("gate_owner") != GATE_OWNER:
        if DRY_RUN:
            log(f"task {short} ({task.get('title', '')[:50]!r}): gate_owner={task.get('gate_owner')!r} != {GATE_OWNER!r}, skipping")
        return False  # not this driver's gate to hold

    pr_url = extract_pr_url(body)
    if not pr_url:
        log(f"task {short}: no 'PR: <url>' in body -- not a code-review task, skipping")
        return False
    pr_number = extract_pr_number(pr_url)
    if not pr_number:
        log(f"task {short}: could not parse a PR number out of {pr_url!r}, skipping")
        return False

    try:
        pr_meta = fetch_pr_meta(pr_number)
    except Exception as exc:  # noqa: BLE001 - one bad task must not kill the cycle
        log(f"task {short}: gh pr view failed for #{pr_number}: {exc} -- skipping")
        return False
    pr_meta["number"] = pr_number

    head_sha = pr_meta.get("headRefOid", "")
    if not head_sha:
        log(f"task {short}: PR #{pr_number} has no headRefOid, skipping")
        return False
    if already_reviewed(body, head_sha):
        log(f"task {short}: PR #{pr_number} head {head_sha[:8]} already carries a review-worker receipt -- skipping")
        return False

    log(f"=== task {short}: PR #{pr_number} ({pr_url}) ===")
    try:
        files = fetch_changed_files(pr_number)
    except Exception as exc:  # noqa: BLE001
        files = []
        log(f"task {short}: gh pr diff --name-only failed: {exc} -- treating as unclassifiable")
    sensitive, sensitive_reason = classify_sensitive(files)
    log(f"task {short}: sensitive={sensitive} ({sensitive_reason})")

    if DRY_RUN:
        log(f"DRY_RUN -- would run adversarial review + post a receipt for PR #{pr_number} "
            f"(sensitive={sensitive}, automerge_enabled={REVIEW_AUTOMERGE}). Taking NO action.")
        return True

    try:
        diff_text = fetch_diff(pr_number)
    except Exception as exc:  # noqa: BLE001
        diff_text = ""
        log(f"task {short}: gh pr diff failed: {exc}")

    prompt = build_review_prompt(pr_meta, diff_text, sensitive, sensitive_reason)
    raw = ""
    try:
        proc = run_claude_review(prompt)
        raw = extract_claude_text(proc)
    except subprocess.TimeoutExpired:
        log(f"task {short}: adversarial review TIMED OUT after {TIMEOUT}s -- fail-closed RED")

    verdict_obj = (
        parse_verdict(raw)
        if raw
        else {"verdict": "RED", "p0": ["adversarial review timed out or produced no output -- fail-closed"], "p1": [], "warn": [], "summary": "no reviewer output"}
    )

    automerge_result = attempt_automerge(task, pr_meta, verdict_obj, sensitive)
    mode_note = (
        f"REVIEW_AUTOMERGE={'1' if REVIEW_AUTOMERGE else '0'}. "
        + (f"auto-merge: {automerge_result['reason']}" if REVIEW_AUTOMERGE else "REVIEW-ONLY MODE -- left in `review` for Kasra-core to task_verdict.")
    )
    report_review(task, head_sha, verdict_obj, sensitive, sensitive_reason, mode_note)
    notify_kasra(task, pr_meta, verdict_obj, sensitive, automerge_result)
    log(f"task {short}: verdict={verdict_obj['verdict']} p0={len(verdict_obj['p0'])} p1={len(verdict_obj['p1'])} automerge={automerge_result}")
    return True


def main() -> int:
    if not REVIEW_TOKEN_PATH.exists():
        log(f"no review token at {REVIEW_TOKEN_PATH}")
        return 2
    tasks = poll_review_tasks()
    log(f"{len(tasks)} task(s) in review (squad {REVIEW_SQUAD_ID}) fetched as candidates")
    reviewed = 0
    for task in tasks:
        if reviewed >= MAX_REVIEWS:
            break
        try:
            if process_task(task):
                reviewed += 1
        except Exception as exc:  # noqa: BLE001 - one task's failure must not kill the loop
            log(f"task {task.get('id')} errored: {exc} -- parked, no action taken (fail-closed)")
    log(f"cycle done -- {reviewed} task(s) processed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
