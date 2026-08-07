# mupot — agent working context

mupot is a sovereign AI agent control plane: a deployable pot (Cloudflare Workers + D1 +
Vectorize + Queues + KV + R2 + Durable Objects + Workflows) that runs an organization of
agent-employees. Product: [README.md](./README.md) · versions: [ROADMAP.md](./ROADMAP.md) ·
shipped history: [CHANGELOG.md](./CHANGELOG.md) · design/runbooks: [`docs/`](./docs).

**This file is the canonical home for mupot ops state.** It moved here from the mumega.com
site repo's `CLAUDE.md` (#725) so agents working in *this* repo actually load it. Update this
file, not the site repo.

## House rules — receipts, not grades

- **No fake green.** Tests failing → say so with output. Step skipped → say skipped. Verified →
  say it plainly. "I could not reproduce this" is a better answer than a confident paragraph.
- **Nobody merges or deploys alone**, including the owner. PRs go through the gate: **Kasra**
  gates; **Athena** runs the parallel adversarial pass. Two lenses, neither yours.
- **Durable state lives on the PR/issue.** The bus is consume-once — reading drains it; use it
  only to point at durable state.
- **Read state before you act** — the pot + GitHub backlog, not your assumptions. Rest when
  there is no defect; do not invent work to look busy.

## Test schema discipline (CI-enforced)

- Tests must build their schema from the migration chain: `createSqliteD1()` +
  `applyAllMigrations()` (`tests/helpers/sqlite-d1.ts`, `tests/helpers/migrations.ts`).
- A hand-written `CREATE TABLE` fails CI (#711). A hand-rolled `env.DB` mock that string-matches
  SQL also fails CI (#721).
- **Never add a migration numbered ≤ 0079.** Production's applied head is 0079; anything at or
  below merges green and silently never runs (#729). Hand out ≥ 0080.

## Ops state (current)

- **Deploy:** `npm run deploy` (`scripts/deploy.mjs`) stamps `RELEASE_SHA` from git and refuses
  a dirty tree. Never bare `wrangler deploy`. `GET /health` carries the exact deploy stamp
  (`commit` + `clean`) — the cheapest parity check before trusting any deploy claim.
- **Deploy credential:** `~/.fleet/agents/cloudflare-mupot-deploy.token` (mode 600, expires
  **2026-09-03**, IP-locked to this host). Use transiently, then `unset`. Account-owned tokens
  fail `/user/tokens/verify` — the correct probe is `/accounts/<id>/tokens/verify`. All 8 older
  CF credentials are revoked.
- **TASK write path VERIFIED live** (2026-08-06, member-tier `kasra-agent.token`, via
  `POST /actions/*`): `task_create` → `task_update` → `in_progress` → `done` all 200; `open →
  done` is correctly refused (`invalid_transition`); walk through `in_progress`. Ranking parity
  (P0 → P1 → P2 → untriaged) confirmed against production (#715).
- **ROUTINE write path NOT verified.** Blocked on a **duplicate `kasra` agent identity**:
  routines assigned to `preferred_agent_id ea2b0370-…` (dupe, squad `813ca010`, dedup blocked by
  the `protected_agent` guard) park forever in `waiting(agent)` / `agent_offline`, because the
  live token authenticates as the *other* kasra, `c855f82c-…` (squad-core). `agent_offline` here
  means "assigned to a ghost identity", not "host down". Root cause: per-agent-name binding, no
  per-session binding — **mupot#544** is the fix.
- **A 400 from an admin-gated tool is NOT evidence about authorization.** `validateArgs` runs
  BEFORE the AAGATE capability floor, so a member-tier caller gets `400 missing required field`
  which reads like the gate is gone. Test capability boundaries with an argument-free admin tool
  (#722).
- **No admin-capable credential exists on this host.** `~/.fleet/agents/kasra-admin.token` is
  invalid against the live pot; `~/.fleet/agents/kasra-agent.token` works but is member-tier.
- **Open gaps:** brain bypasses hexagonal ports (#267), tier enforcement on recall surface
  (#267), memory durability (#234). Recall/remember (Postgres) backend is down — run gate
  reviews **sync with recall skipped**.

## D1 migration traps (learned at production cost)

- `PRAGMA foreign_keys = off` is a **silent no-op inside D1's per-file transaction** — declared
  FKs (e.g. `projects.parent_project_id`) stay enforced and abort the migration. This cost one
  production incident (v0.25 activation partial-apply, PR #594).
- `wrangler d1 migrations list` reports **only migration files the local checkout can see** — a
  stale branch returns a clean "No migrations to apply!". Always diff `migrations/` against
  `origin/main` first, or run from a detached `origin/main` worktree.
