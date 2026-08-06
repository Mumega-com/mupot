# Codex handoff — Agent Connection Foundation (#528)

- **Date:** 2026-07-24
- **Assignee:** Codex (implement)
- **Reviewer:** Cursor (red-team / gate only — do not implement both sides)
- **Tracking:** https://github.com/Mumega-com/mupot/issues/528

## Mission

Ship **rollout steps 1–3 only**: migration + synchronized access + race-safe mint + sole-writer cutover for existing MCP/REST/dashboard credential surfaces.

In this handoff, foundation also includes `provisionAgentConnection`, the
high-level MCP `provision_agent_connection` tool, request/receipt persistence,
and retention. These are the transactional infrastructure used by the
sole-writer cutover, not the deferred verification or dashboard experience.

Do **not** build the verification callback, messaging proof, polling, wizard,
receipt UI, or production-deploy in this slice.

## Authority (read in this order)

1. Design: `docs/superpowers/specs/2026-07-24-agent-connection-flow-design.md`
2. Implementation plan (task-by-task, TDD): `docs/superpowers/plans/2026-07-24-agent-connection-foundation.md`
3. This handoff (scope + review gates)
4. Issue comments on #528 (red-team P0/P1 history)

Use the plan’s task checkboxes. Prefer `superpowers:subagent-driven-development` or `executing-plans`.

## Implementation roadmap

Execute the foundation in this order:

1. **Clean execution base** — create an isolated branch from latest `main`,
   bring forward only the approved agent-connection documents, and record the
   baseline typecheck/test result.
2. **Task 1: database contract** — add migration `0071` with canonical
   bindings, request/receipt tables, race/immutability triggers, the
   pending-target unique index, and real-SQLite tests.
3. **Task 2: canonical mint** — make identity resolution and agent-bound token
   minting binding-aware, revoke-surviving, and safe under concurrent
   first-mint attempts.
4. **Task 3: synchronized access** — add `setAgentSquadAccess` as the sole
   membership/capability writer with the permanent home ceiling and target
   authorization checks.
5. **Task 4: pinned origin** — require safe `PUBLIC_ORIGIN` configuration
   before credential mutation and remove Host-derived credential output.
6. **Task 5: sole-writer cutover** — delegate existing MCP mint/grant, REST
   membership, and dashboard credential paths to the shared services.
7. **Task 6: provisioning boundary** — add actor-scoped reservation,
   `provisionAgentConnection`, MCP `provision_agent_connection`, atomic
   provisioning, non-secret receipts, and retention maintenance.
8. **Task 7: release-candidate evidence** — run the focused security matrix,
   typecheck, full suite, diff/file-map audit, and secret/direct-writer checks.
9. **Independent gate** — open the PR against `main`, reference #528, list
   deferred follow-ons, and request Cursor's red-team verdict. Codex does not
   approve its own implementation.

## In scope

- `migrations/0071_agent_connections.sql` (bindings, requests, receipts, triggers, pending-target unique index, ambiguous-weld preflight guard)
- `src/members/agent-access.ts` — sole `setAgentSquadAccess` writer
- `src/members/agent-connection.ts` — `provisionAgentConnection` reservation + provisioning batches
- Binding-aware `mintAgentBoundToken` / identity resolution in `src/members/service.ts`
- Delegate: `mint_agent_token`, `grant_agent_capability`, REST `POST /api/org/agents/:id/memberships`, dashboard agent-token mint
- Add MCP tool `provision_agent_connection` (high-level; no wizard)
- Strict pinned `PUBLIC_ORIGIN` for snippets/endpoints (no Host fallback)
- Home-squad capability ceiling `observer|member` at every entry point
- REST membership gate `lead` → `admin` when delegating
- Vitest coverage listed in the foundation plan Task 7 matrix

## Out of scope (follow-on plans)

1. `verify_agent_connection`, `AuthContext.tokenId`, challenge/poll ACL, receipt status UI
2. Owner dashboard wizard (“Create or connect agent”)
3. Live pot migration, deploy, production mint/revoke

## Hard fail-closed rules

- One canonical `agent_member_bindings` row per `(tenant, agent_id)`; never invent a second member for the same agent.
- Concurrent mint loser re-reads winner binding; never leave `agent_identity_ambiguous` by racing inserts.
- Raw token: memory only, show once, never in receipts/logs/snippets.
- No `legacyOwnerAdmin` shortcut inside `setAgentSquadAccess`.
- `create_agent` never creates member/binding/capability/token.
- Unminted `grant_*` / REST membership / `register_agent_key` → `agent_identity_unminted` (no create-on-missing).
- Prefer refusing agent-bound callers on provision/mint/grant (`operator_principal_required`) unless the design footnote explicitly allows agent→agent provisioning — default **refuse** and test it.

## Done when

- [ ] All foundation-plan tasks 1–7 green (focused matrix + `npm run typecheck` + `npm test`)
- [ ] Diff matches the plan file map (no wizard chrome, no drive-by refactors)
- [ ] PR opened against `main` referencing #528
- [ ] PR body links design + this handoff + lists residual follow-ons
- [ ] Request Cursor review comment on the PR (security matrix from #528)

Run the baseline on the clean branch before Task 1. If latest `main` already
has full-suite failures, record the exact failures and stop before claiming
this done bar. Resolve them separately or obtain an explicit project decision;
do not silently redefine green as "no new failures."

## Branch / commit hygiene

- Branch from latest `main`: `feat/agent-connection-foundation` (or equivalent)
- One reviewable commit per plan task (plan says do not squash before review)
- Conventional commits: `feat:`, `test:`, `fix:` as appropriate
- Do not commit secrets, wrangler production secrets, or live token material

## If blocked

Stop and ask on #528 when:

- Production pot has ambiguous historical welds (migration guard fires)
- Plan and design disagree on a security invariant
- A task requires editing out-of-map god-files beyond the listed touch points for no test reason

Do not “silently repair” ambiguous identities.
