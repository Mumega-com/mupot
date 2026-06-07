# Changelog

All notable changes to mupot. Semver; pre-1.0 minor bumps may break.

## [0.2.1] — 2026-06-07

Hardening pass — adversarial parallel-gate review of everything 0.2.0 shipped.

### Security
- **P0 — PATCH gate-bypass closed.** The gate guarded the verdict endpoint, but
  `PATCH /api/tasks/:id` was a second write path to `done` that ignored
  `gate_owner` — a member could force a gated task complete with no verdict, no
  capability check, no receipt. Now `patchToDoneBypassesGate()` refuses
  PATCH-to-`done` on a gated task unless it is post-verdict (`approved`/`rejected`).
- **P2 — fleet bus scoping.** `/fleet/wake` gated to owner/admin (was any member);
  fleet bus `/send` + control pinned to project `sos` so the admin-scoped HQ
  token cannot fan out cross-tenant.

### Reviewed GREEN (held under attack)
Member MCP seam (identity always server-derived), verdict authz / self-approval
block / race guard / receipt immutability, observatory (bound params + escaped
output, no tenant leak), bridge `GET /fleet` (no secret/hash leak, auth + project
scoping). 154 tests.

## [0.2.0] — 2026-06-07

The week mupot got hands, gates, and its first human user.

### Added
- **Task execution** — execute-mode cortex cycle: an assigned agent DOES the task;
  result + completion persist on the task row (migration 0006).
- **/dashboard/send** — write a task in plain language, pick an agent, watch the result land.
- **Gate primitive** (migrations 0007 + 0008): `review/approved/rejected` statuses,
  transition matrix, `gate_owner` capability, append-only `task_verdicts` receipts,
  `gate_grants` RBAC, self-verdict prevention (audited owner override).
- **/dashboard/approvals** — the gate queue; visibility == verdict authority.
- **/dashboard/** observatory — swimlane of agents over 24h, operator queue, recent tasks.
- **/dashboard/fleet** — company-wide agent roster over the bus (liveness, last-active,
  run/pause/deactivate via receipted control requests).
- **Browser-surface hardening** — CSRF Origin check + `no-store` + `no-referrer`.
- **Per-tenant pots** — `wrangler.<tenant>.toml`; mupot-digid + mupot-house deployed.
- Google OAuth login (first sign-in = owner).

### Fixed
- AgentDO self-lookup used the derived DO hex id instead of `ctx.id.name` — every
  real wake 409'd `agent_not_found` (mocked tests stayed green). Surfaced by the
  first live human execution.
- Default model id `@cf/meta/llama-3.3` did not exist → 5007; replaced with
  `@cf/meta/llama-3.3-70b-instruct-fp8-fast`.
- All 9 Dependabot alerts resolved (mcp-sdk, agents, vitest 4).

## [0.1.0] — 2026-06-03

Initial substrate: org model (departments → squads → agents), capability RBAC,
member tokens (show-once), memory, internal bus (Queues + DO), channels seam,
setup wizard, Discord slash-command proof.
