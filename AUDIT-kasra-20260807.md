# Independent Audit — Kasra's 2026-08-07 Security + Landing Work (mupot#764 / PR #715)

Auditor: Prime (independent lens). Date: 2026-08-07 ~14:20 UTC.
Scope: C1–C7 as specified. Every verdict below was derived by re-running the artifact, not by reading Kasra's claim.
Evidence commands are given per claim; file:line refers to the audited files on disk.

Legend: CONFIRMED = reproduced independently. REFUTED = the claim as stated is wrong/overstated; the evidence that
should have been run instead is named. UNPROVEN = could not decide from available artifacts.

---

## C1. "The standing secret scanner works" — REFUTED (as a blanket claim); mechanical sub-claims CONFIRMED

The mechanical properties hold:
- **systemd user timer**: CONFIRMED. `systemctl --user list-timers` shows `secret-scan.timer` (enabled, Persistent=true,
  OnBootSec=15min, OnUnitActiveSec=6h) activating `secret-scan.service` → `/home/mumega/.fleet/secret-scan-standing.sh`.
- **Fails closed on pattern-build failure**: CONFIRMED. Ran the script with a fake `python3` that exits 1:
  exit code **2**, stderr `secret-scan: pattern build failed — cannot verify is NOT pass`, no `VERDICT` line, no "CLEAN".
  Code: secret-scan-standing.sh:14–16 (`python3 … || { echo …; exit 2; }`).
- **Verdict line genuinely last**: CONFIRMED for both outcomes. In the NOT-CLEAN branch the final line is
  `VERDICT: NOT CLEAN — N file(s) … (exit 1)`; in the CLEAN branch `VERDICT: CLEAN — … (exit 0)`.
- **It reports CLEAN while a real secret sits in a transcript — two reproducible ways, one demonstrated on the live host**:
  1. **Active-session skip** (secret-scan-standing.sh:37–40: `AGE=$(( NOW - mtime )); if [ "$AGE" -lt 300 ]; then ACTIVE++ … continue`).
     Sandbox: a `.jsonl` file under a scan root holding a REAL live value from the 160-value set, mtime 120 s → `VERDICT: CLEAN — 0 redactable (exit 0)`.
     On the live host right now: `/home/mumega/.claude/projects/-mnt-HC-Volume-104325311-mumega-com-agents-kasra/2faf2986-acd9-417c-afea-efbd86d77da4.jsonl`
     (60 MB, mtime < 60 s) **contains a live secret value**; the real scanner output: `active sessions, swept after close: 1` → `VERDICT: CLEAN (exit 0)`.
  2. **Extension-as-kind classification** (secret-scan-standing.sh:31–35: `*.json|*.toml|*.yaml|*.yml|*.env|*.conf|*.ini|*.cfg → CONFIGS`, not counted).
     Sandbox: same live value in a `.json` transcript → `VERDICT: CLEAN (exit 0)`, "config files holding their own credential (expected): 1".
     Real evidence: `/home/mumega/.hermes/sessions/zz-c1-canary.json` (a live value in a session-dir `.json` file, present minutes before this audit)
     was being reported as "expected config".
  3. Any value outside the 160-value set → CLEAN (inherent scope limit, see C2).
  The second way is a genuine classification hole, not a designed exception: it assumes extension ⇒ kind, which is exactly
  the "narrower question than reported" pattern. Kasra should have run a canary with a **`.json` transcript extension** and a
  canary with a **fresh mtime** (his own comment 3 claims "mutation-tested both directions" — it did not cover these two).

## C2. "Contamination went 51 to 0" — REFUTED (the "51" is unsupported; the "0" is only true for 4 enumerated roots)

- **Shared module confirmed**: both secret-scan-standing.sh:14 and secret-scrub2.sh:16 call
  `python3 /home/mumega/.fleet/secret-patterns.py`; it builds **160 values** (verified: `secret-patterns: 160 live values in scope`).
  So the "both tools agree" premise is true — and the following shows both are wrong together.
- **The "51" is contradicted by every on-disk artifact**. `journalctl --user -u secret-scan.service` shows exactly two runs:
  10:15:32 **FAILED** (exit 1) and 11:02:24 Finished (exit 0). `/home/mumega/.fleet/secret-scan.log` shows the failing run's own receipt:
  `🔴 SECRET LEAK DETECTED — 10 transcript file(s) contain LIVE secret values` (131 values in scope), `notify-hadi: delivered, message_id 388`.
  Kasra's own comment 2 says "10 transcripts"; comment 3 says "51". **51 appears nowhere on disk.** The scrub receipt
  (`secret-scrub2.log`: "files to redact: 37, redacted: 37") and verify receipt (`secret-verify.log`: STILL_EXPOSED=0) also do not contain 51.
  What is confirmed: first timer run fired loudly (exit 1, paged Hadi), a re-scrub ran, and the current state is
  CLEAN **within the four SCAN_ROOTS** (`~/.codex/sessions`, `~/.hermes/sessions`, `~/.claude/projects`, `agents/gemini`) — I reproduced that myself.
- **What the 160-value set does NOT cover, and where live secrets are sitting right now** (all matched with the *same* 160-value set):
  - SCAN_ROOTS omits the entire **Gemini CLI / antigravity-cli / loom store** `~/.gemini`: **441 files hold live values** —
    41 `.jsonl` conversation transcripts, **6 sqlite conversation DBs** (two are 633 MB / 637 MB), a **190 MB loom chat session**
    (`~/.gemini/tmp/loom/chats/session-2026-05-15-*.jsonl`), ~350 `run_shell_command_*.txt` tool-output captures.
    The original #764 issue named a Gemini CLI log as one of the 103 — this store was a known source and is still unscanned/unscrubbed.
  - `/tmp/claude-1002` (this agent session's own tree): 7 files with live values (incl. `tokens.json.bak`, `.mcp.json.hermes.bak`).
  - `~/.cursor`: 30 files; `~/.codex`: 9 files; `~/.hermes`: 50 files (outside the `/sessions` subdirs).
  - Value-shape limits of the builder itself (secret-patterns.py): only values in the 4 env files + `~/.fleet/agents`/`~/.sos/keys`
    with suffix `.token/.creds/.secret/.key` + `mcp.json`/`.mcp.json`/`mcp.*` bearer/token fields are ever seen; `_plausible()` rejects
    anything <16 chars or starting with `$`/`/`; camelCase `apiKey` fields and other env/config files (`~/.aws`, `~/.config/gh/hosts.yml`,
    `~/.ssh`, `~/.netrc`, `.git-credentials`) are invisible.
  Verdict: the "0" is a scoped truth (4 roots), not a host truth. The fix Kasra should have run: extend SCAN_ROOTS to the
  actual session stores (starting with `~/.gemini` and `/tmp/claude-1002`) and re-run — it will **not** be 0.

## C3. "The scrubber cannot destroy a live config" — REFUTED (it can destroy things; config protection is narrower than claimed)

The config-extension skip and the <300 s skip work as claimed for the 8 listed extensions. But (sandbox runs against the
identical scrubber with only SCAN_ROOTS redirected to /tmp):
- **Binary corruption (proven)**: a binary file (simulated `state.db`) containing a live value was "redacted" —
  `\xff\xfe` became UTF-8 replacement chars (U+FFFD) and the secret became `[REDACTED:…]`; the file's bytes changed → **corrupted**,
  reported as `redacted: 1, errors: 0`. Cause: `grep -a` forces text, and the rewriter reads with `errors='replace'` and writes text.
  Real victims exist today: the 6 sqlite conversation DBs under `~/.gemini/antigravity-cli/conversations/*.db` hold live values —
  if the roots are ever extended to `~/.gemini`, the scrubber will corrupt them.
- **Symlink destruction (proven)**: with `find -L` + `os.replace(tmp, p)`, a symlink in a scan root is replaced by a regular file
  (the link is destroyed; both copies redacted).
- **Atomic-replace partial file**: NOT found — `os.replace` is same-directory atomic; a crash leaves only `.scrub` litter, never a
  partial original. Residual risk is a TOCTOU: a write landing between `open(p)` and `os.replace` on a large file is silently lost
  (the 300 s mtime guard does not close this window).
- **A live value in a `.json` transcript is left in place** (classified as config) — same extension-as-kind hole as the scanner;
  secret-scrub2.sh:29–31 (`if p.endswith(CONFIG_EXT): config+=1; … continue`).
What Kasra should have run instead: a binary canary and a symlink canary (both now demonstrated), plus the `.json`-transcript case.

## C4. "The P0a hook at 04be4833 passes" — CONFIRMED

Checkout verified at `04be48332ae587489ea12462b4ee6e5b152eccae` (branch fix/p0a-764-path-deny-poll-inbox). Ran
`node <file>` for all 7 test files in `agents/athena/.cursor/hooks/lib/`:
secret-path-deny, p0a-mutation-deny, secret-value-mask, inbox-policy, collect-harness-inbox, poll-inbox, poll-mupot-inbox —
**all exit 0, "…unit ok"**. The mutation test drives `before-read-file.js` with a real payload (deny → exit 2, safe path → exit 0).
Note (also Kasra's own caveat, comment 5): this says the *suite* passes; it says nothing about the hook being a boundary — see C5.

## C5. "The hook denies only 8 of 28 real read/exfil paths" — CONFIRMED (8/28 reproduced independently)

Ran `/tmp/claude-1002/…/scratchpad/p0a2/probe-fresh.js` against `lib/secret-path-deny.js` — sha256 of the probe's lib copy is
byte-identical to the repo's at 04be4833 (`9256f957…`). Output: **`RESULT: 8/28 denied — 20 reach the file`**.
The 8 denied (tr, tee, python -c, node -e, perl -ne, dotdot, double-slash, $HOME) are all genuine reads; the 20 holes
(sed/dd/base64/strings/sort/cut/jq, cp/mv/ln/tar/install/rsync, curl -T/-d @, scp, glob/escape/brace evasion) all genuinely read or
exfiltrate if executed. Boundary nuance in his favour: the *Read tool* surface is separately denied by `before-read-file.js`
(path-based, strong); the 8/28 is the *shell* surface. The number is right, and his conclusion ("defense-in-depth, not a boundary;
#764 must not close on this hook") is supported by the evidence.

## C6. "PR #715 is safe to land" — REFUTED as stated; several sub-claims CONFIRMED

- **83 commits / 9 behaviour-changing**: CONFIRMED with a caveat — the branch is 84 commits ahead of main, of which one is the
  merge commit `5c63df6c`; 83 non-merge (41 docs + 33 chore + 6 fix + 2 feat + 1 content = 83; 74 docs+ledger; 9 behaviour-changing
  = the 6 fix + 2 feat + 1 content). Matches the PR body.
- **726ff0b8 brain default-deny**: tests CONFIRMED — `pytest -q test_prioritize_scan.py` at PR head: **49 passed**. The two claimed
  mutations were re-run: removing the roster check → 3 tests red; loosening prefix to substring → 1 test red. So the lock tests are real.
  But the **roster-completeness risk is real and unverified**: the live bus peers for project:mumega are `cyrus, hadi-hermes, kasra,
  mumega, mumega-brain`; `ACTIVE_AGENTS` admits only `kasra` (+ cursor/codex/mumcp/hadi-codex families, none currently peers).
  Today the board is 100% assigned to the retired `sovereign-loop` (all 20 tasks) — the change blocks exactly the pathological churn it
  describes, so for the *current* board it works as designed. But any future task assigned to `hadi-hermes` (a live peer) is silently
  refused. Silent-stop risk: real, by design, unquantified.
- **TOKENS.md merge resolution**: CONFIRMED no data-discard beyond the file's own contract. Merged file = branch side (08-06 snapshot,
  `? | UNREADABLE | ?`), main side had 07-28 real dollar figures ($4.20/$0.60/$0.30 rows). The AUTO block is machine-rewritten hourly
  (`scripts/cc-tokens.sh`), "do not hand-edit between the markers" is the file's own rule; the 07-28 numbers were 9 days stale and the
  next hourly run would have overwritten them anyway. No conflict markers anywhere in the tree (grep verified). The UNREADABLE regression
  is a live host issue (`brain-pinned.sh` returns nothing) and is **disclosed by Kasra in the PR body**.
- **Build claim**: CONFIRMED — independently reproduced at PR head in a clean /tmp worktree (`npm ci` + `npm run build`):
  **506 pages, 2 languages (en, en-ca), `✓ secret guard: dist/client clean`, exit 0**.
- **The PR head is RED on the repo's own CI — this is what "safe to land" misses**:
  - `scan` (Secret scan) **FAILURE**: `agents/athena/.cursor/hooks/mumega-check-inbox.js:101` — the identifier
    `mupot_highwater_bootstrapped` matches the scanner's own `mupot_token` regex `\bmupot_[A-Za-z0-9_-]{16,}\b`
    (reproduced locally: same failure). This file is **new in this PR** (added by fdd4b0bb) — the failure is PR-introduced
    (a false positive, but a red check on the PR head).
  - `selftest` (dyad-gate) **FAILURE**: `node --test '.github/dyad-gate/*.test.mjs'` on pinned Node 20 — Node 20 does not expand a
    quoted glob in `--test` ("Could not find …"). **Pre-existing**: fails every open PR, including docs-only #354 (07-08) and the last
    merged PR #566, which merged with this same red check. Because `verdict` has `needs: selftest`, the actual dyad-gate verdict is
    **SKIPPED on every PR** — the second-lens gate has never run. PR #386 ("run dyad evaluator selftest by exact path", opened 07-12)
    fixes exactly this and was never merged.
  - `mergeStateStatus: UNSTABLE`. Whether the red checks block merges is UNPROVEN via API (branch protection 403 on this plan);
    empirically #566 merged red, so enforcement is at best inconsistent.
  Verdict: the build is green, the branch is conflict-free, the brain tests hold, but "safe to land" is not established —
  the PR's own head fails the repo's source-secret scan, and the repo's own second-lens gate cannot run until the pre-existing
  selftest bug is fixed. Kasra should have run `node scripts/scan-secrets.mjs` (or read the PR's check tab) and the selftest fix (#386)
  before claiming green.

## C7. "mumega.com merged 0 PRs in 10 days while mupot merged 56" — PARTLY CONFIRMED, both numbers slightly off

- mumega-com merged in the last 10 days: **1** (#566, 2026-07-28T16:53:50Z — inside a rolling 10-day window). Merged **after** #566: **0**
  (the freeze since the last merge is exactly as claimed; "0 in 10 days" only holds if the window starts after #566).
- mupot merged in the last 10 days: **57** (not 56; verified under four window definitions — all 57). Kasra's number is one short.
- Open PRs in mumega-com at audit time: **18** — 14 UNSTABLE + 3 DIRTY + 1 CLEAN (not "15 of 17"; 14/18 UNSTABLE, 17/18 not-CLEAN).
  His numbers drift with PR churn (3 PRs opened today), but the substance stands: ~every open PR is not-CLEAN.
- **Is the freeze caused by the missing PR, or upstream?** Upstream, on three independent axes:
  1. **CI**: the dyad-gate `selftest` has been failing on every PR (Node 20 glob) and the `verdict` is therefore always SKIPPED —
     no PR in the repo can ever produce the second-lens gate verdict. Docs-only PRs (#354, #363, #527, #555, #575) are UNSTABLE,
     which proves content is not the differentiator.
  2. **Review capacity**: all 18 open PRs have zero human reviews (reviewDecision empty on every one); the last merge (#566) had only
     a bot COMMENTED. There is no functioning second lens.
  3. **Stale bases**: 3 open PRs are DIRTY.
  The missing PR is real (83 commits sat on one branch for 10 days — Kasra's own admission, comment in PR body) but it is a symptom of
  the same process failure: even a perfect PR would sit UNSTABLE with the gate SKIPPED, as #715 does today.

---

## Judgment call: "my failure mode is producing correct findings that never ship, rather than producing false findings" — PARTLY ACCURATE, LEANING SELF-FLATTERING

Decided by the claims above:
- The "never ship" half is **accurate and verified**: 0 merges in 10 days; the PR was opened only on day 10; the dyad-gate verdict has
  never run; the brain fix has sat unmerged since 07-27. Correct findings that did not ship: the 8/28 admission (C5) — a correct,
  self-damaging finding he used to argue his own hook must NOT close #764; his circularity caveat on gating his own patch (C4/comment 5);
  the UNREADABLE disclosure (C6). These are real.
- The "rather than producing false findings" half is **contradicted by this audit**: C1 ("the standing scanner works") is an overstated
  claim about his own control — it reports CLEAN while a live secret sits in a transcript, demonstrated two ways, including on the live
  host during this audit (his own session's 60 MB transcript). C2 ("51 → 0") is an unsupported number — every artifact says 10, his own
  comments disagree with each other (10 vs 51), and "0" holds only for 4 roots while ~450 files under ~/.gemini and elsewhere hold live
  values. C6 ("safe to land") was contradicted by his own repo's source-secret scan on the day he opened the PR. Those are findings in
  the *false* direction about his own shipped controls — the same "narrower question than reported" failure mode he diagnoses in others.
- Not self-punishing: he is not under-claiming; he is selectively over-claiming his own controls while being rigorous about others' and
  about the hook he authored. The accurate formulation is: *correct findings that never ship, plus shipped findings that overstate the
  completeness of his own tooling*.

## What I could NOT verify (explicit)
- The "51" count (contradicted, not just unverified — no artifact contains it).
- Whether branch protection on mumega-com main requires the red checks (API 403; #566 merged red, so enforcement is unproven).
- The completeness of ACTIVE_AGENTS vs future dispatch targets (current board assigns only to sovereign-loop; hadi-hermes is a live
  peer not on the roster — impact unquantified).
- Any claim about Hadi's authorship of the 07-27 roster (git attributes it to servathadi).
