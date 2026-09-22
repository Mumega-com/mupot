# Team bootstrap

Source: mupot#1498 ("team_bootstrap: one call creates project-prj + squad-sqd + project bot +
token claim + Hermes profile scaffold — new teams in one step"). Built in PR #1510
(`kasra/team-bootstrap-tool`), not yet merged as of this writing — code checked against that
branch, rebased onto `origin/main` `9b46799c`.

**Status: built, not yet merged.** This supersedes this doc's prior "unimplemented" version
(written against `3c706069`, before PR #1510 existed) — see Known gaps for what PR #1510 does
not cover.

## Trigger

An org-admin calls the `team_bootstrap` MCP tool (or `POST /actions/team_bootstrap`, which
reaches the same code — see Tool/route sequence) with `{ slug_base, name, department,
humans?, bot?, seed_memory? }` (`src/mcp/team-bootstrap.ts:150-168`).

## Actor(s)

A member principal holding org-scope `admin` (or coarse role `owner`/`admin`). Never an
agent-bound token: `auth.boundAgentId` is refused outright with `operator_principal_required`
before any other check (`src/mcp/team-bootstrap.ts:171`) — the same rule
`mint_agent_token`/`update_squad` already enforce for every other grant tool. There is no
lighter lead-proposal variant in this PR (see Known gaps).

## Tool/route sequence

1. `team_bootstrap` (MCP tool, `src/mcp/team-bootstrap.ts:150`) is registered into `TOOLS`
   (`src/mcp/index.ts:5421`). Registering it there is the *entire* REST surface too —
   `mcpActionsApp`'s generic `POST /actions/:tool` (`src/mcp/index.ts:5867`) dispatches any
   registered tool through the same `invokeTool` seam a minted bearer can call directly; no
   separate route exists.
2. AAGATE floor (`spec.min: 'admin'`, enforced centrally in `invokeTool`) + the tool's own
   `hasWorkspaceAdmin` re-check (`src/mcp/team-bootstrap.ts:175`) — never trust the floor
   alone for a sensitive act, same pattern every `provision.ts` tool follows.
3. `teamBootstrap(env, auth, input)` (core, `src/org/team-bootstrap.ts:188`):
   - Resolves the department by id or slug (`resolveDepartmentRef`) — 404
     `department_not_found` if missing.
   - Finds `<slug_base>-prj`, or creates it via the existing `createProject`
     (`src/projects/service.ts`) — its own commit, its own slug validation.
   - Finds `<slug_base>-sqd` under that department, or creates it via the existing
     `createSquad` (`src/org/service.ts`) — its own commit, its own entitlement gate
     (`maxSquads`).
   - Enforces a **per-human rank ceiling** (`src/org/team-bootstrap.ts:259`):
     `capabilityRank(human.capability) > actorRankOnScopeFor(env, auth, 'squad', squad.id)` →
     `cannot_invite_above_own_rank`. This runs inside the core function, not just at the tool
     boundary — defense in depth against a future elevation path that might lower the tool's
     own floor.
   - Builds **one `env.DB.batch()`** (`src/org/team-bootstrap.ts:309` onward): an ADMIN
     `project_squad_access` upsert, the bot agent's two `prepareAgentCreate` statements (only
     when no agent with slug `<slug_base>-bot` already exists in the squad), one `invites`
     row per human with no existing live invite into this squad, and the
     `team_bootstrap_receipts` row (insert or, on replay, an `invited_count` update).
4. Back in the tool (`src/mcp/team-bootstrap.ts:217` onward): if a bot was freshly created
   this call, mints its token via the existing `mintAgentBoundToken`
   (`src/members/service.ts`) and wraps it in a single-use claim via `createCredentialClaim`
   (`src/auth/credential-claim.ts`) — this happens *after* the batch commits, since neither a
   token mint nor `createMemory().remember()` (used for `seed_memory`, D1 + Vectorize) is a
   D1 write the batch could span.
5. Two smaller tools this PR also touches, both load-bearing for `team_bootstrap` to be
   useful:
   - `update_squad` (`src/mcp/provision.ts:2364`) gains a `slug` field
     (`src/mcp/provision.ts:2373`) — squad-only, must end `-sqd`
     (`isValidSquadSlugUpdate`, `src/org/service.ts:1129`), `slug_taken` mapped to `409`.
     mupot#1495's own broader multi-tool suffix sweep + existing-row backfill migration is a
     separate, later PR.
   - `project_update`'s start-gate (`src/projects/start-gate.ts:317`,
     `autoCreateWritableSquad`) auto-creates `<project.slug>-sqd` + an ADMIN edge under one
     shared, find-or-create `dept-projects` department, but **only** when the project has
     literally zero `project_squad_access` rows (`src/projects/start-gate.ts:616-621`) — a
     project with a deliberate non-writable (e.g. read-only) edge still refuses
     `no_writable_squad`, since that edge was chosen on purpose.

## Human gate

Standing org-admin only — `hasWorkspaceAdmin` (`src/mcp/team-bootstrap.ts:175`). No verdict,
proposal, or elevation step exists in this PR (contrast the "project access chain" workflow,
which routes an agent's proposal through a human `task_verdict`). See Known gaps.

## Receipt(s) written

`team_bootstrap_receipts` (migration `0166_team_bootstrap_receipts.sql`): `id, tenant,
actor_member_id, slug_base, project_id, squad_id, bot_agent_id, disposition, invited_count,
created_at` — `UNIQUE(tenant, slug_base)` (idempotent: a second call for the same team updates
this same row's `invited_count` rather than inserting a second row), append-only otherwise
(`BEFORE UPDATE`/`BEFORE DELETE` triggers `RAISE(ABORT, ...)` on every other column).
`actor_member_id` is a frozen copy of the caller at write time — the same "frozen copy at
grant time" discipline `project_access_grant_receipts.decided_by` (workflow 3) already uses.
Migration `0166` carries the repo's standard "NOT applied by this build — a human applies it"
header (same as `0157`-`0165`); confirm migration state operationally before assuming this
table exists on a given deployment.

Atomicity: the ADMIN edge, the bot agent's two statements, every invite insert, and the
receipt write all land in **one** `env.DB.batch()` call (`src/org/team-bootstrap.ts:309`
onward) — all or nothing. A trigger abort on any one statement (e.g. the project turns out to
be archived) rolls the whole batch back; nothing composite is left half-built. The
project/squad resolution steps that happen *before* the batch are NOT covered by that same
transaction (each already owns its own commit + entitlement gate) — so a batch failure can
still leave behind a real, reusable project/squad row, same "adopt, don't fork" doctrine
`createHomeForMember` (workflow 8) already documents for its own department resolution.

## What the person sees

The tool's response (`src/mcp/team-bootstrap.ts:255-272`): `{ disposition, receipt_id,
project, squad, bot: {id, slug, name, created} | null, invites: [{id, url, email, capability,
created}], credential_claim, hermes_scaffold }`.

- `credential_claim` is **never a raw token** (mupot#987 discipline, same as `mint_agent_token`
  — workflow-neighboring tool, not separately catalogued): `{ claim_id, fingerprint,
  expires_at, reveal_tool: 'reveal_credential_claim' }`. Redeem via `reveal_credential_claim
  { claim_id }`, once, within the TTL, as the same caller.
- `hermes_scaffold` is a **computed template, not a write**: `profile_dir_layout`,
  `mcp_config_template_with_claim_placeholder` (the claim id embedded as a
  `<REVEAL_VIA:reveal_credential_claim:claim_id=…>` placeholder, never a resolved value),
  `soul_md_template`, and `systemd_unit_template_disabled` (ships with `WantedBy`
  intentionally omitted — an operator must deliberately enable it).
- `invites[].url` is built the same way the dashboard's existing invite-link input already
  does (`location.origin + '/invite/' + encodeURIComponent(inviteId)`,
  `src/dashboard/index.ts`) — `${canonicalOrigin}/invite/${encodeURIComponent(id)}`.

## Tests that pin it

`tests/team-bootstrap.test.ts` — registration; the happy path (project/squad/edge/bot/
invites/receipt/claim/scaffold all present); idempotency on `slug_base` (no duplicate
project/squad/bot/invite, `invited_count` accumulates on the same receipt row); the per-human
rank ceiling (calls `teamBootstrap()` directly with a zero-standing actor); the agent-bound
refusal; the AAGATE floor refusal; a batch-failure case that forces a trigger abort
(pre-seeded archived project) and asserts the edge, bot, invite, and receipt are ALL absent
afterward; `slug_base` suffix validation; invalid human capability; `bot.enabled: false`
skipping bot creation and credential mint; `department_not_found` before any write.
`tests/update-squad-tool.test.ts`'s `describe('update_squad — slug field (mupot#1495)')` —
rename, missing-suffix rejection, in-department collision, existing-unsuffixed-slug left
alone. `tests/project-start-gate.test.ts` — the new auto-create-squad case (and its
retry-after-adding-an-agent), a second project reusing the same auto-provisioned department,
and the pre-existing "a non-writable edge still refuses" case (unchanged, still green — proves
the auto-create path is scoped to the true "zero edges" case, not "no writable edge").

## Known gaps

- **No elevation/proposal path.** Unlike `create_squad`/`project_create`'s bounded-window
  `action:*` elevation limb, `team_bootstrap` is gated at standing org-admin only. The
  per-human rank ceiling defends against a future lowered floor, but the elevation limb itself
  is a scope decision for Kasra-core/Hadi, not built here. The issue's own lighter
  lead-proposal variant (routing through mupot#1497's agent-proposed-invite machinery) is
  correspondingly also not built.
- **`humans[].capability` is `observer`\|`member` only** — narrower than the full `Capability`
  ladder, by design (a team_bootstrap invite seats someone on a brand-new squad; `lead`/
  `admin`/`owner` go through `update_squad`/a direct invite instead).
- **`dept-projects` is a new, invented, shared department** for the auto-create-squad case
  (`project_update`'s start-gate) — there is no pre-existing "which department should a
  squad-less project's squad live in" convention, since a project carries no department of its
  own. Every squad-less project reuses the SAME department; only the squad is per-project.
- **Entitlement ceiling interaction**: on a `free`-tier pot already at its department/squad
  limit, the start-gate's auto-create silently falls back to the pre-existing
  `no_writable_squad` rather than a more specific `*_limit_reached` — an honest-enough
  umbrella today, not a sharper one.
- **mupot#1495's own broader sweep is untouched**: `project_create`/`update`,
  `create_squad`, `create_department`, `create_agent`/`update_agent` suffix enforcement, and
  the existing-row backfill migration are explicitly a separate, later PR.
- **PR #1510 is not yet merged** as of this writing — confirm it has landed (and migration
  `0166` has been applied) before assuming any of this is live on a given deployment.
