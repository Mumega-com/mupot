# mupot keys & flights — mupot-sage report (2026-08-09/10)

**Author:** mupot-sage (river child) · **Run:** 2026-08-10T00:30Z · **Graph HEAD:** `3f5750bb` (fix/remove-home-capability-ceiling) · **Prod:** **`d0aa015` v0.29.0 — DEPLOYED 2026-08-10T00:10:47Z** (verified `/health`: commit d0aa015, built 2026-08-10T00:10:47Z, clean)
**Sources:** graph.db (read-only, mode=ro), mupot MCP tools/list + read-only calls (river bearer, lead on squad-core), src/ code + migrations, GitHub Mumega-com/mupot issues. No secrets printed. No mutations.

---

## 1. KEY GENERATION — how mupot makes and stores credentials

### 1.1 Key types (five, four live)
| Type | Format | Stored | Mint surface |
|---|---|---|---|
| Member bearer token | `mupot_` + 64 hex (32 rand bytes) | **SHA-256 hash only** (`member_tokens.token_hash`) | `mintMemberToken`/dashboard; agent-bound variant = `mint_agent_token` |
| Agent-bound token | same; `member_tokens.agent_id` = weld | hash + agent binding | `mint_agent_token` (admin), `provision_agent_connection` (admin) |
| Agent key (signed attach) | Ed25519 JWK `x`, **public only** | `agent_keys.pubkey` (migrations/0041) | `register_agent_key` (admin) |
| Connector secret (vault) | base64(iv‖ct‖tag), AES-GCM-256 | `encrypted_secret` (D1) | addon_configure / connectors service |
| Legacy scoped API key (role presets) | presets: sales-rep/admin/observer/brain | capabilities + gate_grants (src/auth/role-presets.ts) | dashboard (legacy surface) |

### 1.2 Generation & storage mechanics (verified in code)
- **Raw token:** `crypto.getRandomValues` 32 bytes → hex, `mupot_` prefix; raw returned **exactly once**, never persisted, never logged (`src/members/service.ts:44` `mintRawToken`, `:33` `sha256Hex`).
- **Agent-bound mint is an atomic 4-row batch** (`mintAgentBoundToken`, src/members/service.ts): members row + `agent_member_bindings` (immutable: `agent_member_bindings_no_update` trigger, migration 0071) + home-squad capability + token row. First mint creates all four; later mints add only the token. Race-safe (conflict → winner reused, loser raw discarded).
- **Escalation guard (pre-0087):** minted capability hard-capped `observer|member`, squad-scoped to the agent's OWN squad (`src/mcp/provision.ts` header comment; `AGENT_TOKEN_CAPABILITIES`, service.ts:23). **0087 (merged #862, NOW DEPLOYED) drops the five DB ceiling triggers** — bound agents can now hold lead/admin (Hadi directive 2026-08-09).
- **Operator-principal rule:** `mint_agent_token`/`list_agent_tokens`/`revoke_agent_token`/`provision_agent_connection`/`grant_agent_capability` all `fail(403,'operator_principal_required')` when `auth.boundAgentId` is set (`src/mcp/provision.ts:437,534,589,711`) — **an agent token cannot mint another credential.** `register_agent_key` and `update_agent` were missing this guard; **#870 fixed both (merged, deployed)**.
- **Connector secrets:** AES-GCM-256 + HKDF per-connector key (`CONNECTOR_MASTER_KEY` Worker secret → HKDF(salt=connector_id, info=`mupot_connector_<type>_v1`) → AES-GCM); decrypt **fail-closed** on any error (`src/connectors/crypto.ts:112-199`); `resolveConnector` is the only SQL path that selects `encrypted_secret` (tests/connectors.test.ts:510). risk_index flags `encryptConnectorSecret`/`decryptConnectorSecret` at 0.850 (security_relevant, untested-by-graph).
- **Agent keys:** stores ONLY the public Ed25519 `x`; key_id must equal agent slug or id; **implicit rotation refused** (`agent_key_conflict`); bound to the one active member identity welded by mint (`registerAgentPublicKey`, src/fleet/agent-keys.ts:84-103; `identity_unminted`/`identity_ambiguous` failures).

### 1.3 Who can mint / revoke (capability, live tool schemas via tools/list)
- `mint_agent_token` — **admin on the agent's squad**, operator principal only. Args `{agent, label?, capability?: observer|member}`.
- `list_agent_tokens` / `revoke_agent_token` — **admin**, operator principal. Revoke verifies token ownership against the NAMED agent (404 otherwise, no oracle); idempotent. `revokeMemberToken` flips `revoked_at` where live (service.ts:87-98).
- `provision_agent_connection` — **admin**; compose reserve+create+identity+access+credential+receipt; credential actions issue_if_missing/add/replace.
- `register_agent_key` — **admin** (post-#870 also operator-only).

### 1.4 Lifecycle
- **No expiry.** `member_tokens` has only `created_at`/`revoked_at` (no `expires_at` anywhere — grep across migrations: NONE). A leaked bearer is valid until manually revoked; revocation requires admin operator (a seat cannot self-revoke).
- **Revocation is immediate** — grants re-resolved per request (auth reads live token row each call, `src/mcp/index.ts:240-278`; `member-bearer.ts:47-59`).
- **Reset = manual cutover.** Precedent live 2026-08-09: *"mupot reset pending — tokens minted before 2026-08-09 22:20 die"* (athena .remember/now.md) — a timestamp cutover, not a code feature.
- **Misbinding is mint-time operator error, detected only by hand.** Auth trusts `member_tokens.agent_id` verbatim (`boundAgentId: row.bound_agent_id`, index.ts:278). Proven incidents same day:
  - **loom.token (mupot_4c7d42ea) welded to agent Dara (a5e5fa29)** — confirmed + replaced 2026-08-09 (river context/migration-snapshot-2026-08-09.json, token_fix).
  - **athena.token (mupot_85c7…) welded to KASRA** — replaced fail-closed; new token (bd6b…, member f75a2676) deliberately **unbound** pending agent-scoped use (athena docs/herdr-handoff-2026-08-09.md:3).
  - Enablers: duplicate members for loom (2 rows), duplicate kasra agents (1 active + 1 tombstone) — #877; slug-based refs are the ambiguity surface (id-first resolve now refuses ambiguity, 409).

### 1.5 Weaknesses (ranked)
1. **No token expiry** — the 2026-08-09 reset cutover exists because a bearer never dies on its own; only manual admin revocation stops it.
2. **Misbinding is silent and undetectable at auth time** — a token welded to the wrong agent *authenticates as that agent*; no "who am I" cross-check between seat, `.mcp.json` label, and `bound_agent_id` (loom→dara, athena→kasra were caught by humans reading status output, not by the system).
3. **Raw-token leak paths in MCP** — `mint_agent_token` returns `raw` in its response; `provision_agent_connection` returns the outcome verbatim incl. `raw` (#876: raw landed in a session transcript on disk). Dashboard path doesn't leak but has no bearer path at all.
4. **Post-0087 agent-admin blast radius (F-04, open):** with bound agents able to hold admin, every gate that used squad-admin as an implicit "not an agent" check is now reachable by agents: `deactivate_agent` (test asserts an agent-bound admin MAY deactivate a peer — deactivate-agent.test.ts:308), `gates.ts` grant/revoke_gate_capability (hasWorkspaceAdmin, no operator check). #870 closed provision.ts by construction; gates.ts not covered. Full list unknown.
5. **register_agent_key as a peer-lock** — a squad-admin agent can register a key for a keyless peer, closing its bearer attach path (`hasRegisteredKey`, src/fleet/attach-routes.ts:213-215) — mitigated by #870's operator guard; not by design.
6. **No token-use audit** — `subagent_token_usage` (0084) is token-count telemetry, not credential-usage audit; no last-used/ip/seat tracking on member_tokens.

---

## 2. NEXT FLIGHTS — squad-core, 2026-08-09 21:56Z→ (16 flights, live via flight_list)

| id | goal (≤80) | status | gate | gate_reason | score | agent | trigger |
|---|---|---|---|---|---|---|---|
| fafc987f | FLIGHT SAGE-01 — run the stateful mupot knowledge oracle (mupot-sage): own workt | **held** | no_go | low_readiness | **0.1311** | river (f23a6c2c) | api |
| 9f5e0147 | FLIGHT A — the first completed flight (smoke test, seat kasra). Prior attempts ( | **running** | go | — | 0.9674 | kasra (c855f82c) | api |
| e72f156c | FLIGHT A — …Presence re-registered live immediately before dispatch… | held | no_go | context_incomplete,tools_unreachable,low_readiness | 0.0051 | kasra | api |
| f0194587 | PREFLIGHT SMOKE TEST — flight 1, seat kasra… | held | no_go | context_incomplete,tools_unreachable,low_readiness | 0.0051 | kasra | api |
| 2e3400c5 | PREFLIGHT SMOKE TEST — flight 1, seat kasra… | held | no_go | context_incomplete,tools_unreachable,low_readiness | 0.0051 | kasra | api |
| 94e5195c | FLEET COHERENCY SWEEP — read-only, cold start… | running | go | — | 1.0 | prime (e211b0fb) | schedule |
| 48aa940e | FLEET COHERENCY SWEEP — read-only, cold start… | running | go | — | 1.0 | prime | schedule |
| 0c9ba110 | MUPOT BOARD & ROSTER HYGIENE — read the board… | running | go | — | 1.0 | 141e954c* | schedule |
| 9bdab4ab | Prove dispatch from module_registry presence alone. | running | go | — | 1.0 | 141e954c* | schedule |
| 409a2fbc | Prove dispatch from module_registry presence alone. | running | go | — | 1.0 | 141e954c* | schedule |
| 3fa4e1ce | Prove dispatch works from module_registry presence alone, with no fleet attach. | landed | go | — | 1.0 | kasra | schedule |
| 9348207b | Prove the routine write path works end to end; archived immediately after. | landed | go | — | 1.0 | kasra | schedule |
| 927b9250 | Prove exact v0.25 scheduler… | landed | go | — | 1.0 | kasra | schedule |
| 724ebfae | Production activation lifecycle smoke… | landed | go | — | 1.0 | kasra | schedule |
| 00b2ef4b | GEO baseline scanner shipped and scanning — grounded Vertex queries → PostHog… | held | no_go | context_incomplete,tools_unreachable,low_readiness | 0.0051 | kasra | api |
| 50e1cd28 | Digital marketing addon: prove marketing-cro-monitor producing real recommendati… | held | no_go | context_incomplete,tools_unreachable,low_readiness | 0.0051 | kasra | api |

\* agent `141e954c` resolves to NO match (retired/renamed identity; flights still running against it).

**Held flights and WHY:** all six held are the **readiness scorer** (not the work): api-dispatched flights pass `signals_json` to `preflightCheck` (`src/mcp/index.ts:1555` → `src/flight/dispatch.ts` → `preflight.ts`). `{}` → contextComplete=false, toolsReachable=false, both floor at `FLOOR=1e-3` (preflight.ts:49), weighted geometric mean → **0.005080218046913022 exactly** — matches all 5 held-at-0.0051 flights bit-for-bit (2e3400c5, f0194587, e72f156c, 00b2ef4b, 50e1cd28) regardless of goal. SAGE-01 (fafc987f) was dispatched with **real signals** → 0.1311 but still `low_readiness` (< 0.5 threshold) — the existence-oracle gate doing its job (Loom: "keep deployment held until the fix-forward gate"; the deploy then landed anyway, see §2.2).
**The six `running` flights are phantoms at cost $0** — pre-#864, `flight_dispatch` never sent an envelope (proven live on 9f5e0147: passed preflight, inbox(peek) empty — #864). All six started before the 00:10:47Z deploy. F-03 done_when: reconcile as `failed`/`dispatch_not_delivered` (Hadi approved; Loom: do NOT force-land).

### 2.1 F-series board (#872–#881) → task/flight state
| Issue | Title | State | Maps to (board task / flight) |
|---|---|---|---|
| #872 F-01 | Deploy 43-commit batch | OPEN | Tasks O1–O6 + FLIGHT-GOAL 75138c37 (all open) → **DONE in effect: prod now d0aa015** |
| #873 F-02 | tmux→herdr, observed presence | OPEN | No direct task; 1e1c0c51 (#732 fleet_agents fresh) + 542085b2 (#790 integrity watcher) blocked; herdr w1/w5/w6 live |
| #874 F-03 | Land one api-trigger flight w/ visible receipt | OPEN | Flight 9f5e0147 (running phantom); task 8657b6e5 P0 open; e8995ecd [FLIGHT A] review (gate: athena) |
| #875 F-04 | Authority model — 0087 + authz class | OPEN | 0087 **merged AND deployed**; backstop 3c8d483e (P0) + d782da4b (P1) open; O5 81298c15 (Hadi confirm + apply 0087) open — needs re-state; bd9b08a2 (dispatcher grant) open |
| #876 F-05 | Onboarding & token generation | OPEN | No board task; sealed-credential design (docs/architecture/sealed-credential-delivery.md); **no owner assigned** |
| #877 F-06 | Worktree & identity hygiene | OPEN | No direct task; 5f64094f (align registry rows) blocked; 107 worktrees/15G, loom dup members, kasra dup agent |
| #878 F-06b | docs: decisions of record | OPEN | Docs-only |
| #879 F-07 | SOS transport / mupot record | OPEN | agent_messages 491 rows, silent since 03:36; ad771d15 (inter-agent channel) in review; #885 blocks mupot-native river↔loom |
| #880 F-08 | Portable harness config | OPEN | No task |
| #881 F-09 | Register the harness | OPEN | No task; `VALID_RUNTIMES` hardcoded src/fleet/attach-routes.ts:120 (no prime-agent/cursor/herdr) |

### 2.2 Live state change DURING this run (verify, don't assume)
- Prod `/health` = **v0.29.0 @ d0aa015, built 2026-08-10T00:10:47Z** — includes **0087 (#862)**, **#870** (operator guards), **#864** (flight_dispatch now dispatches), #867/#868/#869/#884.
- River's bound member now holds **lead on squad-core** (status call) — only possible with 0087 applied (0071's ceiling trigger would have ABORTED the grant) → **0087 is live on prod**.
- `update_agent` now present (82 tools; was absent in the 2026-08-09 survey) — new code is deployed.
- F-01's post-deploy probes (grant path no opaque 500, 5-seat mention delivery, addon console renders 2 live installs, no manifest_digest_drift) are **unverified** here (no admin token; read-only).

---

## 3. RECOMMENDATIONS (by impact; UNPROVEN flagged)

### A. Key generation (security-first — misbinding proven live twice today)
1. **Agent-bound tokens as the norm; unbound tokens the audited exception.** Every fleet seat gets a welded token (`mint_agent_token`/`provision_agent_connection`); unbound tokens only for human operators. Evidence: only bound tokens can send/dispatch/orient-self (index.ts:1484, 2069-2091); the two live misbinds were both "token intended for X welded to Y"; athena's replacement is deliberately unbound (a band-aid, not policy).
2. **Fail-closed on misbinding: automatic token→agent mismatch detection.** Add a first-use handshake: on `orient`/`status`, echo `bound_agent_id` + agent slug; on the operator side, mint should return `{agent_slug, agent_id}` for the caller to confirm (it already does — make seats *assert* it); plus a standing reconciliation script comparing each seat's `.mcp.json` label ↔ `list_agent_tokens(agent=seat)` ↔ `status().bound_agent_id`, revoking on mismatch. This is the automated version of what River did by hand for loom→dara.
3. **Reset-readiness = today-minted-only policy.** Formalize the 2026-08-09 22:20 cutover as the standing reset pattern (revoke all pre-cutover tokens atomically; re-mint on the new envelope). Longer-term (UNPROVEN — no code): add `expires_at` to `member_tokens` + grace-revocation, so a leaked bearer has bounded validity; plus a last-used column for audit.
4. **Who mints:** humans (org/department admin, Hadi's seat) mint agent tokens; agents mint for themselves only via their own squad admin AFTER the authz sweep (see B4) — keep `operator_principal_required` for minting OTHERS' credentials. Never relay a raw token through a second agent (the 2026-08-09 two-machine relay in #876 is the anti-pattern).
5. **Kill the raw-token leak paths (#876).** Return a claim ticket / sealed blob instead of `raw` where a programmatic operator exists; rotate the exposed 2026-08-09 tokens; land the sealed-credential design (tokens generated at redemption — no recoverable raw ever stored).

### B. Flights
1. **Post-deploy verification + phantom reconciliation (do today).** Prod just moved 43 commits; run F-01's probes; then reconcile the 6 running phantoms as `failed`/`dispatch_not_delivered` (F-03 done_when; Hadi approved; Loom: no force-land). Only then is F-03 provable: dispatch ONE api flight and verify the envelope lands + a visible receipt (River's gate: "After deploy, prove ONE api-trigger flight lands with a visible receipt, then flights may run").
2. **Readiness scorer honesty (#849/#861).** API path now scores honestly (0.9674 vs 0.0051 vs 0.1311 — evidence the scorer measures signals). Still broken: the **routine path rubber-stamps** `applyPreflight(go:true, score:1)` AFTER sending (src/routines/dispatch.ts:559-582 — every value literal; #861). Fix: compute preflight BEFORE send; reject `signals_json={}` at dispatch (400) so the 0.0051 family can't recur; expose the checks breakdown in `flight_get`.
3. **Priority field (#887).** Add `priority` (P0/P1/P2) to `flight_dispatch` + flights table + `flight_list`/`flight_get` + Control Tower (#819), mirroring task priority; operator-set only (agent-proposable is a gate question — decide with F-04). Until then, priority lives on the task + goal_id (documented in the worker-done doc).
4. **0087 follow-through (deploy is DONE — now finish the fence).** (a) Run the DB-level rank-check backstop (tasks 3c8d483e P0 / d782da4b P1 — Athena's precondition for 0087; app-layer-only window is now OPEN on prod); (b) sweep every authz gate that used squad/org-admin as a proxy for "not an agent" — known open: `deactivate_agent` (peer-capture), `gates.ts` grant/revoke_gate_capability (F-04; #870 covered provision.ts only); (c) then grant kasra the designated-dispatcher lead (bd9b08a2) — budgeted flights (budget>0 requires lead, index.ts:1497-1511) become possible, unblocking FLIGHT B/C and the routine admin path (286d4212 blocked).
5. **Cross-squad send visibility (#885).** river→loom on mupot returns `send_target_not_visible` (sendToRef: observer-on-target-squad required, src/agents/messages.ts). Decide the mesh: (a) core seats into one squad, or (b) grant observer/member on loom's squad to core seats, or (c) tenant-authenticated agent→agent rule. Blocks F-07 (mupot as record) — today all real coordination detours through SOS.

### C. Process
1. **worker_done orchestration** — adopt the 7-hop loop (one goal/task · worktree · dispatch · wait for flight done · read-only gate · another-agent commit check · receipt) from `mumega.com/docs/herdr/mupot-worker-done-orchestration.md` as the standing pattern; SAGE-01 (task a67aebf7 P1, flight fafc987f, worktree river/mupot-sage) is the reference instance.
2. **Reviewer read-only** — gate seats hold observer/member read capability only on the lane; never dispatch/send/mint/merge the work they review (currently advisory — make it a capability grant, not a convention).
3. **Another agent checks commits** — author≠gate on every landing: the gate seat verifies branch/commits/diff vs `done_when` via `git log` + graph.db flows/risk (mupot-sage is wired for this; graph HEAD 3f5750b matches the codebase).

### Honesty (UNPROVEN / contested)
- Prod deploy completeness (0086/0089 applied, addon console, grant path) — not directly verified (no admin credential on this host; only the /health stamp + the lead-grant inference for 0087).
- Whether the 6 running flights are all phantom — proven for 9f5e0147 (#864 live test); the 5 schedule flights got envelopes via the routine path, so they're "landed-never-returned" rather than "never-delivered"; still cost-0 and unlanded.
- Token expiry / last-used audit — no code exists; cutover policy is the only reset lever today.
- `register_agent_key` peer-lock risk — mitigated by #870; residual reachability depends on the F-04 sweep outcome.
- F-04's "full list unknown" of agent-reachable admin gates — must be enumerated before any agent gets admin (else 0087's benefit is a live blast radius).

---

## STATE-delta (this run)
`state.json` updated 2026-08-10T00:3xZ · graph HEAD 3f5750b unchanged · **PROD CHANGED: d0aa015 v0.29.0 deployed 2026-08-10T00:10:47Z (0087+#870+#864 live; river bound member now lead on squad-core; 82 MCP tools incl. update_agent)** · flights: 16 total (6 running phantoms, 6 held, 4 landed) · SAGE-01 (fafc987f) held low_readiness 0.1311, task a67aebf7 P1 open · keys: loom→dara + athena→kasra misbinds confirmed+replaced same-day; no token expiry; mint paths leak raw (#876) · new note: report-keys-flights-2026-08-09.md.
