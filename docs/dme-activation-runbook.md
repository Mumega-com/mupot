# DME Activation Runbook — first paying agency tenant, end-to-end through mupot

**Status as of 2026-07-19:** platform side DONE. Four activation gates remain, all
human-authorized by design (customer infra + credential mint + watched flight).
This runbook makes each gate one motion.

## Done (no action needed)
- **v0.24 Project Operations LIVE** on mupot.mumega.com (Worker `b1544dff`, migrations
  `0056`–`0062` applied to live D1, rollback bookmark
  `000010d5-00018e28-000050ad-51729afdcd05f4a0f8f9f7e613e6f627`).
- **DME security gate — dual-model GREEN** (Sonnet ×3 kasra-review + Opus different-lens):
  send-target confinement (welded token reaches only its own squad; no existence oracle)
  + project-link SSRF (redirect-refuse, private-range block). PR #401 @ `32dc535`.
- **`DME Integration` child project** exists (`ecb4322d-c2d2-4f43-b618-a2381b04b931`),
  **`DME Delivery` squad** (`6d30a543-f3fb-4ae5-84c1-7347fdacdccb`) with write grant (#394).
- **Mint conditions from the Opus gate** (must hold at Gate B):
  - (a) provision the DME token THROUGH `mintAgentBoundToken` (dashboard `/admin/agent-token/mint`
    or the 3-row batch) — a dedicated fresh member envelope, squad-scoped, capability capped
    `member`/`observer`, **zero extra capability rows** on that member. Nothing else keeps the
    send-confinement fence tight.
  - (b) #403 (inbound task-content trust + `*.localhost`/special-name SSRF gap) only blocks
    **wiring the outbound link surface** (`createProjectLink`/`deliverProjectLinkEnvelope`,
    currently unwired) — NOT the token mint. Close #403 before Gate C's cross-pot delivery.

---

## Gate A — Upgrade `dme-temp` to Projects/project-link  ·  **needs Hadi (customer-pot deploy)**
Per Codex design (#392, BLOCK 2): no DME token mint before the destination pot runs the same
Projects/project-link code. Uses the existing Hadi-approved operator path to `dme-temp`.

1. Deploy v0.24 Projects/project-link to the DME destination pot (`dme-temp`).
2. Create the DME-side destination project + squad + agent + the project-link mapping
   (distinct IDs from the Mumega coordinator project — the design forbids same-ID).
3. Verify via authenticated API: live version compat + exact project/link/agent IDs on both sides.

**Blocker for Kasra:** `dme-temp` is on Hadi's Mac Kubernetes — no session access. Hadi runs the
deploy (or grants the operator path). Kasra verifies the ID/version chain once reachable.
**Rollback:** revoke the link; destination pot deploy is independent of Mumega's.

## Gate B — Mint `dme-hermes-k8s` welded token  ·  **needs Hadi DIRECT go (HIGH-stakes credential)**
Only after Gate A verifies the destination is live + compatible.

- Mint via `mintAgentBoundToken` (condition a). Allowlist per Codex final design:
  `boot_context, orient, status, check_in, peers, inbox_consumer_status, project_get,
  project_squad_list, task_list, task_board, task_update, flight_get, flight_list,
  flight_land, send`. **No memory tools** (member-scoped, would break the one-project ceiling).
  Zero org grants; one DME-project squad member grant; separate Ed25519 key.
- Raw token show-once, encrypted to the recipient, never in logs/argv/bus cleartext.
**Rollback:** revoke the token row; re-mint is idempotent.

## Gate C — Zero-overlap legacy retire  ·  mechanical, after Gate B
Per Codex design: provision fresh identity, immediately deactivate legacy
token/key/inbox-fence/subscriber/ACL/bindings/caches — **no 30-min grace**, fresh-token-only
rollback. Quiescence gate first: legacy subscriber stopped, no active legacy flight/claim.
Retirement verifier enumerates + removes every legacy binding; old UUID never reused.
**Pre-req:** close #403 before any real cross-pot delivery runs.

## Gate D — One watched correlated flight  ·  **needs Hadi approval + watching** → DME LIVE
Issue #427: one governed Mumega→DME cross-pot flight. Live-flight verifier requires the full
chain — task + flight + dispatch + landing + Host identity + activation — and independently
verifies Ed25519 (matching hashes alone are NOT authentication). Sanitized receipt lands in
BOTH pots. Isolation proof (adversarial deny tests: every excluded tool, wrong
project/recipient/task/flight, uncorrelated reply, forged receipt) runs separately BEFORE early
retirement — the flight proves execution/round-trip only.

**On green:** DME is live as the first paying agency tenant, operated end-to-end through mupot.

---

## The one thing Kasra can still do without a gate
Phase-1 same-pot provisioning (register `hadi-mupot-dme` in `DME Delivery`, wire its Hermes
plugin, seed integration tasks) is Mumega-pot-only — but the token mint inside it is still Gate B.
Kasra holds here until Hadi's Gate A/B go. Everything above is turnkey; each gate is one motion.
