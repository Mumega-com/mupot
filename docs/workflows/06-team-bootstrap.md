# Team bootstrap

Source: mupot#1498 ("team_bootstrap: one call creates project-prj + squad-sqd + project bot +
token claim + Hermes profile scaffold — new teams in one step"). Built in PR #1510
(`kasra/team-bootstrap-tool`), not yet merged as of this writing — code checked against that
branch after its adversarial round-2 fixes, rebased onto `origin/main` `9b46799c`.

**Status: built, not yet merged.** Round 1 of Athena's gate on PR #1510 was GREEN-to-round-2;
round 2's own adversarial pass found 1 P0, 4 P1, and 5 P2 findings, all fixed on the same
branch (this doc reflects the fixed shape, not the original PR #1510 push). This supersedes
this doc's original "unimplemented" version (written against `3c706069`, before PR #1510
existed).

## Trigger

An org-admin calls the `team_bootstrap` MCP tool (or `POST /actions/team_bootstrap`, which
reaches the same code — see Tool/route sequence) with `{ slug_base, name, department,
humans?, bot?, seed_memory?, adopt? }` (`src/mcp/team-bootstrap.ts`).

## Actor(s)

A member principal holding org-scope `admin` (or coarse role `owner`/`admin`), with a real
`auth.memberId` (refused `actor_required` otherwise — P2-3, below). Never an agent-bound
token: `auth.boundAgentId` is refused outright with `operator_principal_required` before any
other check — the same rule `mint_agent_token`/`update_squad` already enforce for every other
grant tool. There is no lighter lead-proposal variant in this PR (see Known gaps).

## Tool/route sequence

1. `team_bootstrap` (MCP tool, `src/mcp/team-bootstrap.ts`) is registered into `TOOLS`
   (`src/mcp/index.ts`). Registering it there is the *entire* REST surface too —
   `mcpActionsApp`'s generic `POST /actions/:tool` dispatches any registered tool through the
   same `invokeTool` seam a minted bearer can call directly; no separate route exists.
2. AAGATE floor (`spec.min: 'admin'`, enforced centrally in `invokeTool`) + the tool's own
   `hasWorkspaceAdmin` re-check — never trust the floor alone for a sensitive act, same
   pattern every `provision.ts` tool follows.
3. `teamBootstrap(env, auth, input)` (core, `src/org/team-bootstrap.ts:428`), IN THIS ORDER:
   1. **Boundary guards** (`:433` — P2-3): `auth.memberId` must be real (`actor_required`
      otherwise); `slug_base`/`name` shape-validated, including LENGTH CEILINGS (below);
      tenant is read from `env.TENANT_SLUG`, never the caller's own claimed
      `AuthContext.tenant` (P2-7 — same doctrine `src/mcp/index.ts`'s file header states for
      every MCP tool).
   2. Department resolved by id or slug — 404 `department_not_found` if missing.
   3. **Humans validated AND deduped** (P2-1): a bad email/capability refuses before any
      write; the SAME email (case-insensitive) appearing twice in one call keeps only the
      FIRST occurrence — the dropped duplicate is reported back in
      `duplicate_emails_in_request`.
   4. **Per-human rank ceiling, on DEPARTMENT scope, BEFORE any create** (`:477` — P1-4):
      `capabilityRank(human.capability) > actorRankOnScopeFor(env, auth, 'department',
      departmentId)` → `cannot_invite_above_own_rank`. Department scope, not squad — the
      squad may not exist yet, and an org/department grant inherits down to it regardless
      (`capability.ts`'s own invariant). Running this before `createProject`/`createSquad`
      means a call that was always going to be refused never burns an entitlement slot on a
      squad/project nobody gets to keep. (Round-1's version ran this on squad scope, AFTER
      the creates — a real, but unreachable-through-the-tool ordering bug, since the tool's
      own org-admin floor always outranks the two invitable capabilities. Fixed regardless:
      defense in depth must hold its OWN invariant even when today's floor makes it
      unreachable.)
   5. Find-or-create `<slug_base>-prj` — its own commit, its own slug validation
      (`createProject`, `src/projects/service.ts`).
   6. **Project status checked BEFORE the squad is ever created** (`:515` — P1-1): an adopted
      `archived` project refuses `project_archived` (409) immediately — before spending a
      free-tier squad-entitlement slot on a squad this call could never finish wiring. A
      RACE that archives the project AFTER this check but before stage 1's edge INSERT
      (below) is still caught: the trigger's own abort text is mapped to the SAME
      `'archived_project'` structural classification, not a generic `'write_failed'`.
   7. **Find-or-create `<slug_base>-sqd`, ownership-checked before adoption** (`:524` — P0,
      see the dedicated section below).
   8. Reads whether each human already has a live invite into this squad, reporting the
      STORED capability for one that exists — NEVER the newly requested one (P2-2: a replay
      requesting a different capability for an already-invited email does not silently imply
      the request changed what was granted).
   9. Finds or prepares the bot agent (`<slug_base>-bot`) — unchanged from round 1.
   10. **Reads the current project<->squad edge and NEVER raises it** (`:597` — P1-2, see the
       dedicated section below).
   11. **Stage 1** (`:609`, one `env.DB.batch()`, only when there is something to write): the
       ADMIN edge INSERT (skipped entirely if an edge already exists — see P1-2) + the bot
       agent's two `prepareAgentCreate` statements (only when a bot needs creating).
       All-or-nothing.
   12. **Stage 2** (`:651`): one `invites` row per human with no existing live invite —
       inserted ONE AT A TIME, not batched. A failure on invite N does not undo invites
       1..N-1; the loop stops at the first failure.
   13. **Stage 3** (`:694`, `writeReceipt` at `:392`): ONE INSERT per ATTEMPT into
       `team_bootstrap_receipts` — ALWAYS attempted, whether stages 11-12 succeeded or
       failed (see Receipt(s) written, below, for why this is an INSERT and not the
       update-in-place design round 1 shipped).
4. Back in the tool (`src/mcp/team-bootstrap.ts`): if a bot was freshly created this call,
   mints its token via the existing `mintAgentBoundToken` (`src/members/service.ts`) and
   wraps it in a single-use claim via `createCredentialClaim` (`src/auth/credential-claim.ts`)
   — this happens *after* stage 3 commits, since neither a token mint nor
   `createMemory().remember()` (used for `seed_memory`, D1 + Vectorize) is a D1 write any
   stage could span.
5. Two smaller tools this PR also touches, both load-bearing for `team_bootstrap` to be
   useful:
   - `update_squad` (`src/mcp/provision.ts:2371`) gains a `slug` field — squad-only, must end
     `-sqd` (`isValidSquadSlugUpdate`), `slug_taken` mapped to `409`. **Renaming INTO a name
     team_bootstrap has already reserved for `x` (a `<x>-prj` project exists, or a
     `team_bootstrap_receipts` row names slug_base `x`) requires department:admin, the OLD
     create_squad floor — squad:admin (this tool's ordinary floor) is not enough**
     (`src/mcp/provision.ts:2433`, `isSlugBaseReserved`/`slugBaseFromSquadSlug`,
     `src/org/team-bootstrap.ts`) — see the P0 section below for WHY: the squat this closes
     IS a rename, so the check has to run on the UPDATE path itself, not only at create time.
     mupot#1495's own broader multi-tool suffix sweep + existing-row backfill migration is a
     separate, later PR.
   - `project_update`'s start-gate (`src/projects/start-gate.ts`, `autoCreateWritableSquad`)
     auto-creates `<project.slug>-sqd` + an ADMIN edge under one shared, find-or-create
     `dept-projects` department, but **only** when the project has literally zero
     `project_squad_access` rows — a project with a deliberate non-writable (e.g. read-only)
     edge still refuses `no_writable_squad`, since that edge was chosen on purpose. The
     auto-created squad starts with no agent in it, so **the FIRST `project_update` call on
     such a project still returns `no_squad_agent`** (a more specific, honest reason than
     `no_writable_squad` — but still a refusal); a retry after an agent is added to the
     now-real squad succeeds. This auto-create emits the SAME `org.provisioned` bus event
     `create_department`/`create_squad`'s own MCP tools emit (P2-4) — a duplicate helper
     (`emitOrgProvisioned`, `src/projects/start-gate.ts`), not an import, to avoid closing a
     new module cycle (see that function's own comment for the exact cycle it would create).

## THE CENTRAL RULE: find-or-create is create + explicit adopt

(Athena, round-2 gate on PR #1510, 2026-09-22 — quoted verbatim because it is the rule this
whole section enforces.) **Adopting a pre-existing squad is a privilege grant** to whoever
already controls it: an ADMIN project<->squad edge, plus a mintable bot placed inside it, plus
(that squad admin already holding `mint_agent_token`'s own floor) a live credential for that
bot. `squadIsAdoptable` (`src/org/team-bootstrap.ts:317`) therefore requires ONE of two
grounds before adopting any pre-existing squad found by `(department_id, slug)`:

- **(a) a PRIOR team_bootstrap attempt already named this exact `squad_id` for this exact
  `slug_base`** — a genuine resumed retry, checked against the append-only receipt trail
  (`team_bootstrap_receipts`), never against the squad's CURRENT state, which whoever
  controls the squad can freely change (renaming it, adding a capability row) to fake
  legitimacy.
- **(b) the squad is genuinely EMPTY right now** — zero `agents` rows, zero `capabilities`
  rows scoped to it — so adopting it hands nobody standing they did not already have.

Neither holding means someone OTHER than a prior bootstrap of this exact team put this squad
here. **Round 1's find-or-create adopted whatever answered, unconditionally** — combined with
`update_squad`'s new `slug` field being gated at squad:admin, ANY squad admin could rename
their own squad to `<future-slug_base>-sqd` and wait: the next legitimate `team_bootstrap`
call for that `slug_base` would grant THEIR squad an ADMIN edge onto a brand-new project and
place a mintable bot inside it, which they — already holding squad:admin — could mint a
token for via `mint_agent_token`. Full takeover of a future team's project, no exploit beyond
"rename a squad and wait."

**The fix**: refused `squad_slug_taken` (409) with the squad's current capability holders in
the detail (`{squad_id, department_id, owners: [{member_id, capability}]}`) UNLESS the caller
passes `adopt: true` AND is `isOrgAdmin` — checked INSIDE `teamBootstrap` itself
(`src/org/team-bootstrap.ts:524`), never trusted from a caller whose own floor might one day
be lowered. An explicit, informed override is not the same act as an accidental adoption:
**exercising it is receipted as its own disposition, `'adopted'`** (not silently folded into
`'existing'`, where it would read as unremarkable) — see Receipt(s) written, below.

## THE ADMIN EDGE IS NEVER SILENTLY RAISED (P1-2)

If a project<->squad edge already exists below `'admin'` (a deliberate `'read'` or `'write'`
link — mirrors `project_update`'s own start-gate doctrine on a deliberate non-writable edge,
above), this call NEVER overwrites it. Round 1's `ON CONFLICT ... DO UPDATE SET access_level
= 'admin'` silently escalated ANY existing edge, however deliberately it had been set to
something lower — team_bootstrap has no business deciding a DIFFERENT tool's access-level
choice was wrong. The fix (`src/org/team-bootstrap.ts:597`) reads the current edge first: no
edge → INSERT admin (`ON CONFLICT ... DO NOTHING` as a same-instant-race backstop, never DO
UPDATE); an edge already at admin → nothing to do; an edge below admin → skip the write
entirely and report it. The response's `edge_kept` field names the level that was preserved
(`null` when this call set, or found, a genuine admin edge).

## Human gate

Standing org-admin only — `hasWorkspaceAdmin`. No verdict, proposal, or elevation step exists
in this PR (contrast the "project access chain" workflow, which routes an agent's proposal
through a human `task_verdict`). The ONE exception is `adopt: true`: an org-admin's explicit
claim of a pre-existing squad is itself the human decision this workflow asks for on that
one, narrow act — receipted, not merely permitted (see above). See Known gaps for the
lighter lead-proposal variant this PR does not build.

## Receipt(s) written

`team_bootstrap_receipts` (migration `0166_team_bootstrap_receipts.sql`): `id, tenant,
actor_member_id, slug_base, attempt_no, project_id, squad_id, bot_agent_id, disposition,
failed_step, failure_reason, invited_count, created_at` —
`UNIQUE(tenant, slug_base, attempt_no)`. Migration `0166` carries the repo's standard "NOT
applied by this build — a human applies it" header (same as `0157`-`0165`); confirm
migration state operationally before assuming this table exists on a given deployment.

**ONE ROW PER ATTEMPT, NEVER UPDATED** (P1-3, kasra-review adversarial round-1 gate on PR
#1510). Round 1 kept exactly one row per `(tenant, slug_base)`, continuously UPDATEd across
retries — and every update-in-place path turned out falsifiable, three separate ways:

1. A squad renamed out from under a `slug_base` leaves the "pinned" `squad_id` pointing at a
   squad that no longer represents that team.
2. A bot created on attempt 2 could be recorded as if it had existed on attempt 1.
3. `invited_count` accumulated onto ONE row regardless of which admin actually placed which
   invites, misattributing a second admin's invites to the first admin's `actor_member_id`.

Every one of those is a symptom of the same mistake: treating a MUTABLE "current state of
this team" row as if it were a historical log. It is not — the fix makes this table match
every OTHER receipt table's actual append-only-COLUMN idiom (0086/0115/0157/0161): **one
INSERT per `team_bootstrap` call, never an UPDATE**. `attempt_no` (1, 2, 3, ... per `(tenant,
slug_base)`) orders a team's attempts without needing a mutable "latest" row;
`invited_count` on any one row is what THAT call itself inserted, never a running total (sum
across `WHERE tenant=? AND slug_base=?` for the team's lifetime total, if ever needed
operationally). Resumability (an orphan project+squad(+bot) pair surviving a failed attempt,
adopted — ownership-checked — by the next attempt) is a property of team_bootstrap's OWN
find-or-create reads against the real resource tables, never of this receipt table, which
merely records what each attempt observed and did.

**`disposition` has FOUR values**:
- `'created'` — this attempt did something new.
- `'existing'` — a pure no-op replay; every row it names was already there.
- **`'adopted'`** — an `adopt: true` override claimed a pre-existing, non-empty squad no
  prior attempt had named (see "find-or-create is create + explicit adopt", above). An
  AUDITED operator decision, always distinguishable from an ordinary replay.
- `'failed'` — the write phase (stage 11 or 12, above) did not finish this attempt;
  `project_id`/`squad_id` are still real, already-committed rows — only the composite
  outcome of THIS attempt is incomplete. `failed_step` names where it stopped
  (`'edge_or_bot'` | `'invite_insert'`); `failure_reason` is a short, STRUCTURAL
  classification (`'unique_violation'` | `'write_failed'` | `'archived_project'`) —
  deliberately NOT the raw driver error text and NEVER an email address or other human PII,
  so this table stays safe to page through operationally without becoming a second place
  secrets/PII could leak from.

## What the person sees

The tool's response: `{ disposition, receipt_id, project: {...Project fields, created},
squad: {...Squad fields, created}, edge_kept, bot: {id, slug, name, created} | null, invites:
[{id, url, email, capability, created}], duplicate_emails_in_request, credential_claim,
hermes_scaffold }`.

- **`project` and `squad` carry `created: boolean`** (P0(b), same shape `bot` and each
  `invites[]` entry already used) — `false` on every adopted/idempotent-replay path, `true`
  only when THIS call minted the row.
- `edge_kept` — see "THE ADMIN EDGE IS NEVER SILENTLY RAISED", above.
- `duplicate_emails_in_request` — lowercased emails that appeared more than once in this
  call's `humans[]`; only the first occurrence was used.
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
  does — `${canonicalOrigin}/invite/${encodeURIComponent(id)}`.

## Tests that pin it

`tests/team-bootstrap.test.ts` (22 cases) — registration; the happy path (project/squad
`created: true`, `edge_kept: null`, `duplicate_emails_in_request: []`, bot/invites/receipt/
claim/scaffold all present); idempotency on `slug_base` (adopted project/squad report
`created: false`, no duplicate invite, no second bot, TWO separate receipt rows — one per
attempt — each with its own `invited_count`); the per-human rank ceiling AND its ORDERING
(a mutation moving the check back after the creates turns the "no project/squad exist"
assertions red — P1-4); the agent-bound refusal; the AAGATE floor refusal; **the squad-squat
scenario end-to-end** (a capability-holding "attacker" squad matching a future slug_base is
refused `squad_slug_taken` with the owner in the detail, zero edges, zero agents, no receipt
— P0); **`adopt: true` + org:admin** claiming that same squad, disposition `'adopted'`,
receipted with the claiming actor (Athena's round-2 sharpening); **`edge_kept`** preserving a
deliberate `'read'` edge, never raised (P1-2); **`project_archived`** refused before the
squad is ever created, AND a race-window variant that archives the project between the
upfront check and the edge INSERT, proving the trigger-error mapping to `'archived_project'`
(P1-1); a stage-1 batch-failure case (injected failure on the edge INSERT, not archived-status
— that is the dedicated case above) asserting the edge/bot/invite are ALL absent but the
failure IS receipted; a partial-failure retry (batch fails on invite 3 of 5, injected) proving
invites 1-2 persist, the failed attempt is its OWN receipt row (never rewritten), and the
retry's success is a SECOND, new row with `invited_count` counting only what THAT attempt
inserted (not a cumulative 5); within-call email dedupe (P2-1); a replay requesting a
DIFFERENT capability for a live invite reporting the STORED one (P2-2); a caller with no
`memberId` refused `actor_required` before any write (P2-3); `slug_base` length ceiling (44
chars — P2-6) and `name` length ceiling (P2-8); `slug_base` suffix validation; invalid human
capability; `bot.enabled: false` skipping bot creation and credential mint;
`department_not_found` before any write. `tests/update-squad-tool.test.ts`'s slug-field
`describe` blocks — rename, missing-suffix rejection, in-department collision,
existing-unsuffixed-slug left alone, AND the reserved-name-rename requiring department:admin
(squad-admin-only → 403; department-admin → allowed; an UNRESERVED name still needs only
squad:admin — P0c). `tests/project-start-gate.test.ts` — the auto-create-squad case (and its
retry-after-adding-an-agent), a second project reusing the same auto-provisioned department,
and the pre-existing "a non-writable edge still refuses" case (unchanged, still green).

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
- **`dept-projects` is a new, invented, shared department** for `project_update`'s
  auto-create-squad case — there is no pre-existing "which department should a squad-less
  project's squad live in" convention, since a project carries no department of its own.
  Every squad-less project reuses the SAME department; only the squad is per-project.
- **Entitlement ceiling interaction**: on a `free`-tier pot already at its department/squad
  limit, the start-gate's auto-create silently falls back to the pre-existing
  `no_writable_squad` rather than a more specific `*_limit_reached` — an honest-enough
  umbrella today, not a sharper one.
- **P3 — ambiguous-slug-across-departments (kasra-review adversarial round-1 gate on PR
  #1510)**: `squads.slug` is `UNIQUE(department_id, slug)`, NOT globally unique — the exact
  string `<x>-sqd` can legitimately exist in two DIFFERENT departments simultaneously. The
  `update_squad` reserved-name check (P0c, above) is department-AGNOSTIC — it asks "does ANY
  `<x>-prj` project or `team_bootstrap` receipt exist for `x`", not "does one exist that
  THIS squad's department would ever be resolved into." A rename in a department team_bootstrap
  would never actually look in can still be blocked by a reservation that belongs entirely to
  a DIFFERENT department's team. Not fixed here — noted as a real, narrow over-blocking edge
  case; the reservation check errs conservative (refuses a few legitimate renames in the rare
  cross-department name-reuse case) rather than permissive (which is what let the P0 squat
  through in the first place).
- **mupot#1495's own broader sweep is untouched**: `project_create`/`update`,
  `create_squad`, `create_department`, `create_agent`/`update_agent` suffix enforcement, and
  the existing-row backfill migration are explicitly a separate, later PR.
- **PR #1510 is not yet merged** as of this writing — confirm it has landed (and migration
  `0166` has been applied) before assuming any of this is live on a given deployment.
