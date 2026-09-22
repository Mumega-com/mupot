# Team bootstrap

Source: mupot#1498 ("team_bootstrap: one call creates project-prj + squad-sqd + project bot +
token claim + Hermes profile scaffold — new teams in one step"). Originally built in PR #1510
(`kasra/team-bootstrap-tool`). **PR #1510's round-2 adversarial gate on
`29728793a300970c4f351e7c5817e63daa01cfb3` found a surviving P0 (kasra-review, 2026-09-22) —
the round-2 fix built an ownership ground for only ONE of this function's TWO find-or-creates
(the squad; the project got nothing). Per the "P0 blocks, two gate rounds max" rule, PR #1510
is superseded by a new branch/PR (`kasra/team-bootstrap-v2`) rather than a third round on the
same PR. This doc reflects the SUCCESSOR shape.**

**Status: built, not yet merged.** Not yet gated by an independent adversarial pass as of this
writing — see the successor PR for current gate status before assuming this is production-safe
or that migration `0166` (still unapplied) has landed.

## Trigger

An org-admin calls the `team_bootstrap` MCP tool (or `POST /actions/team_bootstrap`, which
reaches the same code — see Tool/route sequence) with `{ slug_base, name, department,
humans?, bot?, seed_memory?, adopt? }` (`src/mcp/team-bootstrap.ts`).

## Actor(s)

A member principal holding org-scope `admin` (or coarse role `owner`/`admin`), with a real
`auth.memberId` (refused `actor_required` otherwise — P2-3, below). Never an agent-bound
token: `auth.boundAgentId` is refused outright with `operator_principal_required` before any
other check — the same rule `mint_agent_token`/`update_squad` already enforce for every other
grant tool. There is no lighter lead-proposal variant in this PR (see Known gaps). **There is
no per-human rank ceiling either** (round 2 built one; the successor DELETES it — see step 4
below for why it was provably unreachable, not merely undertested).

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
   4. **The per-human rank ceiling is GONE — deleted, not fixed.** Round 2 ran
      `capabilityRank(human.capability) > actorRankOnScopeFor(env, auth, 'department',
      departmentId)` on department scope before any create. kasra-review's round-2 gate
      (finding 6) proved it structurally unreachable: this tool's own floor
      (`hasWorkspaceAdmin`, step 2 above) means every caller that ever reaches this function
      is already org:admin, whose rank always dominates the `'observer'`/`'member'` ranks the
      ceiling compared against — it could never fire. Its only test proved this by calling
      `teamBootstrap()` directly with `capabilities: []`, a principal `invokeTool` itself
      refuses before reaching this function at all. Deleted along with that test. If a
      lower-privilege path into this tool is ever added, a per-human rank ceiling belongs
      back here, made real against THAT path's floor and proven with a principal `invokeTool`
      actually admits.
   5. **Resolve BOTH `<slug_base>-prj` and `<slug_base>-sqd` by READ ONLY — neither is
      created yet** (P1-A, successor to PR #1510's round-2 P0). Round 2 created the project
      FIRST, then discovered the squad name was taken — an orphan project, zero receipt, a
      permanent name reservation, no retry path. The successor finds both first.
   6. **Project status checked immediately if found** (P1-1, carried forward): an `archived`
      project refuses `project_archived` (409) before either name's adoptability is even
      checked. A RACE that archives the project AFTER this check but before stage 1's edge
      INSERT (below) is still caught: the trigger's own abort text maps to the SAME
      `'archived_project'` structural classification, not a generic `'write_failed'`.
   7. **BOTH the project and the squad limb run the SAME ownership check before either is
      created** (P0, see the dedicated section below) — a squad `kind='home'` is fenced
      unconditionally first (P2-4). A refusal on EITHER limb writes a `'failed'` attempt
      receipt (`failed_step: 'name_resolution'`) and creates NOTHING — not even the limb that
      would have been fine on its own.
   8. Only once both names clear does either get CREATED (find-or-create proper) — its own
      commit, its own slug validation, its own entitlement gate
      (`createProject`/`createSquad`), stamping `created_by_member_id` with the acting admin.
   9. Reads whether each human already has a live invite into this squad, reporting the
      STORED capability for one that exists — NEVER the newly requested one (P2-2: a replay
      requesting a different capability for an already-invited email does not silently imply
      the request changed what was granted).
   10. Finds or prepares the bot agent (`<slug_base>-bot`) — unchanged from round 2.
   11. **Reads the current project<->squad edge and NEVER raises it** (P1-2, see the
       dedicated section below).
   12. **Stage 1** (one `env.DB.batch()`, only when there is something to write): the
       ADMIN edge INSERT (skipped entirely if an edge already exists — see P1-2) + the bot
       agent's two `prepareAgentCreate` statements (only when a bot needs creating).
       All-or-nothing.
   13. **Stage 2**: one `invites` row per human with no existing live invite —
       inserted ONE AT A TIME, not batched. A failure on invite N does not undo invites
       1..N-1; the loop stops at the first failure.
   14. **Stage 3** (`writeReceipt`): ONE INSERT per ATTEMPT into
       `team_bootstrap_receipts` — ALWAYS attempted, whether stages 12-13 succeeded or
       failed (see Receipt(s) written, below, for why this is an INSERT and not the
       update-in-place design round 1 shipped).
4. Back in the tool (`src/mcp/team-bootstrap.ts`): if a bot was freshly created this call,
   mints its token via the existing `mintAgentBoundToken` (`src/members/service.ts`) and
   wraps it in a single-use claim via `createCredentialClaim` (`src/auth/credential-claim.ts`)
   — this happens *after* stage 3 commits, since neither a token mint nor
   `createMemory().remember()` (used for `seed_memory`, D1 + Vectorize) is a D1 write any
   stage could span.
5. Three smaller tools this PR also touches (the third, `team_bootstrap_release`, is new —
   P1-1, round 2 of the successor), all load-bearing for `team_bootstrap` to be useful:
   - `team_bootstrap_release` (`src/mcp/team-bootstrap.ts`, core in `src/org/
     team-bootstrap.ts`'s `releaseTeamBootstrapSlugBase`) — org-admin only, bound-agent
     refused, same gating shape as `team_bootstrap` itself. `{ slug_base }` → 404
     `project_not_found` if `<slug_base>-prj` doesn't exist, 409 `project_has_edges` if it has
     ANY `project_squad_access` row, otherwise DELETEs the project and writes a
     `'released'`-disposition attempt receipt naming it. See "Release path" below for how this
     composes with `isSlugBaseReserved`.
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
     **Successor addition (P3-2): the auto-created squad now also stamps
     `created_by_member_id` with the start-gate's acting admin** — the SAME provenance column
     `team_bootstrap`'s adoption check reads (below), so a LATER `team_bootstrap` call
     adopting this exact squad by derived slug recognizes it as that actor's own prior work
     instead of falling through to the `adopt: true` override every time. The existing "zero
     `project_squad_access` rows" gate already prevents a SECOND admin-edge squad from ever
     being auto-created for a project that has one — unchanged, not a new fix.

## THE CENTRAL RULE: find-or-create is create + explicit adopt

(Athena, round-2 gate on PR #1510, 2026-09-22 — quoted verbatim because it is the rule this
whole section enforces, and the exact rule PR #1510's round 2 applied to only ONE of the two
find-or-creates below — the surviving P0 that made this doc's PR a successor rather than a
third round.) **Adopting a pre-existing project OR squad is a privilege grant** to whoever
already controls it: for the squad, an ADMIN project<->squad edge plus a mintable bot placed
inside it plus (that principal already holding `mint_agent_token`'s own floor) a live
credential for that bot; for the project, the SAME edge and bot, onto a row whose `name`,
`repo_url`, and `worker_name` (`project_deploy`'s own deploy target) the caller never chose.

`findAdoptGround` (`src/org/team-bootstrap.ts`) is the ONE adoptability check for BOTH limbs —
called once for the resolved project, once for the resolved squad, each independently. Either
ground is sufficient to adopt, and NEITHER holding means someone OTHER than this actor's own
prior work put the resource here: refused (see the ground rule + refusal-receipt rule below,
which are one mechanism, not two), UNLESS the caller passes `adopt: true` AND is `isOrgAdmin`
(checked INSIDE `teamBootstrap` itself, never trusted from a caller whose own floor might one
day be lowered):

- **(i) a PRIOR team_bootstrap attempt already named this exact resource id for this exact
  `slug_base`, WITH `disposition IN ('created', 'adopted')`** — a genuine resumed retry,
  checked against the append-only receipt trail (`team_bootstrap_receipts`), never against the
  resource's CURRENT state, which whoever controls it can freely change to fake legitimacy.
  The disposition filter is load-bearing, not decorative (round 2 of this successor, P0 — see
  below): a `'failed'` receipt is never itself adoption ground, no matter what it names.
- **(ii) `created_by_member_id` on the row equals the calling actor** — they made it
  themselves, through whatever tool, before this call.

**THE GROUND RULE AND THE REFUSAL-RECEIPT RULE ARE ONE MECHANISM (P0, kasra-review adversarial
gate, round 2 of this successor, 2026-09-22 — "the refusal manufactures its own adoption
ground").** The first cut of this rewrite's own resolve-both-before-create logic (below) wrote
a REFUSED resource's id into the SAME `project_id`/`squad_id` columns ground (i) reads for a
successful attempt — with no disposition filter on that read either. The result: call 1
refuses a planted squad (no `adopt: true`) and writes a `'failed'`/`'name_resolution'` receipt
naming it; call 2 — same args, still no `adopt: true`, even a DIFFERENT admin — found that
exact receipt as `'prior_attempt'` ground and silently ADOPTED the planted squad, wiring an
ADMIN edge and a mintable bot inside it. Every legacy row with NULL `created_by_member_id` was
adoptable this way by simply calling twice. The fix has two independently-sufficient parts,
both schema-enforced (CHECK constraints in migration 0166, not application discipline alone):
the ground (i) disposition filter above, AND — the refusal-receipt rule — a `'name_resolution'`
failure's `project_id`/`squad_id` are now ALWAYS `NULL`; the refused resource(s) go in the NEW
`refused_project_id` / `refused_squad_id` columns instead, which nothing but this row's own
audit trail ever reads. (The disposition filter alone still matters for a DIFFERENT case: a
genuine stage-1/stage-2 write failure DOES carry real `project_id`/`squad_id` — the resources
were legitimately created/adopted before the later write failed — and without the filter, a
DIFFERENT actor, not the one who created them, could silently resume that failed attempt
without `adopt: true`; a same-actor resume is unaffected, covered by ground (ii) regardless.)

**"Empty" is NOT a ground, on either limb, deliberately.** PR #1510's round 2 gave the squad
limb a THIRD ground — zero `agents` rows, zero `capabilities` rows scoped to it — reasoning
that adopting an empty squad "hands nobody standing they did not already have." kasra-review's
round-2 gate on that fix (finding 2) measured the hole directly: `createSquad` grants its
creator NO capability row at all, so **every freshly created squad satisfied that test** —
the round-1 squat this ground was meant to close was trivially reproducible by a strictly
LOWER principal than round 2 assumed (measured with the repo's own elevation fixture, `tests/
elevation-squad-lead-e2e.test.ts`: a squad lead holding `lead` on its own squad, no admin
anywhere, under a 60-minute human-approved `action:project_lifecycle` elevation). Provenance
replaces emptiness outright rather than widening it; a pre-existing row with NULL
`created_by_member_id` (everything created before migration 0166 added the column) is
adoptable only via the explicit `adopt: true` override, never via emptiness.

**The PROJECT limb had NO ground at all in round 2** (finding 1, the P0). Measured: a squad
lead under an org-scoped `action:workspace_project` elevation created `payroll-prj` via
`project_create`; the org admin's LATER `team_bootstrap {slug_base:'payroll'}` adopted that
exact row — id-match true — keeping the planter's `name`/`repo_url`/`worker_name`, wiring an
ADMIN edge onto it, and minting a bot inside the admin's new squad, reported
`disposition:'created'`. `findAdoptGround` now runs identically on the project.

**Resolve BOTH names before creating EITHER (P1-A).** Round 2 created the project FIRST, then
discovered the squad name was taken (finding 4) — an orphan project, ZERO receipt, a
permanent name reservation, no retry path. The successor finds both `<slug_base>-prj` and
`<slug_base>-sqd` (read only) and clears both adoptability checks before creating anything. A
refusal on EITHER limb writes a `'failed'` attempt receipt (`failed_step: 'name_resolution'`,
`failure_reason: 'project_slug_taken'` or `'squad_slug_taken'`) instead of returning silently —
`project_id`/`squad_id` on that row are ALWAYS `NULL` (this is the refusal-receipt half of the
P0 fix above, not merely "the limb that wasn't found"); the resource(s) that were found and
refused are named in `refused_project_id`/`refused_squad_id` instead, which no adoptability
check ever reads.

**Release path (P1-1): a real, receipted tool, not merely a documented alternative.** A
`'failed'` receipt reserves a `slug_base` for `update_squad`'s rename floor
(`isSlugBaseReserved`) only WHILE the project it names still exists — `isSlugBaseReserved`
joins each candidate receipt against a live `projects` row and ignores receipts whose project
has been deleted (or that never named one, or is `NULL`). The `team_bootstrap_release` MCP
tool (org:admin only, bound-agent refused, same floor as `team_bootstrap` itself) is the
RECEIPTED way to trigger that: `{ slug_base }` → refuses `project_not_found` if the project
doesn't exist, refuses `project_has_edges` (409) if it has ANY `project_squad_access` row (a
real, in-use project is never releasable — only a genuine orphan is), otherwise deletes the
project and writes a `'released'`-disposition attempt receipt naming it. Because the project
is gone, `isSlugBaseReserved`'s own EXISTS join stops counting every receipt that ever named
it — the release row included — automatically; no special-casing was needed for the new
disposition.

**Home fence (P2-4).** A resolved squad with `kind === 'home'` is refused unconditionally —
`adopt: true` cannot override it, checked before the ordinary adoptability check even runs.
Latent-only in production (the canonical home slug `home-<8hex>` can never end in `-sqd`), but
no longer depends on that coincidence of naming.

**The fix (unchanged from round 2 in shape, now on both limbs)**: refused `squad_slug_taken` /
`project_slug_taken` (409) with the resource's `created_by_member_id` (and, for the squad, its
current capability holders) in the detail, UNLESS the caller passes `adopt: true` AND is
`isOrgAdmin`. An explicit, informed override is not the same act as an accidental adoption:
**exercising it is receipted, and disposition is `'adopted'` on EVERY path that adopted rather
than created something** — not folded into `'created'` the way round 2 did for every ground
except the explicit-override branch (finding 7). `'created'` fires ONLY when BOTH the project
and the squad were newly made by this attempt; `'existing'` is reserved for the narrowest
case — both matched a PRIOR team_bootstrap attempt (a true resumed retry) and this call made
no bot and sent no new invite either. See Receipt(s) written, below.

**`created_via_elevation_grant` (Athena ruling relayed 2026-09-22, mupot seq 5238).** A second,
narrower provenance column alongside `created_by_member_id`: `elevation_grants.id` when the
row was created under a bounded `action:*` elevation rather than standing capability — `NULL`
in the common case (standing admin) or for a pre-migration row. Stamped at both call sites
that can create under an elevation (`project_create`'s `action:workspace_project` check,
`create_squad`'s `action:project_lifecycle` check — `src/mcp/projects.ts`/`src/mcp/
provision.ts`, capturing `hasElevatedAction`'s returned `grant.id`); `team_bootstrap`'s own two
creates and `start-gate`'s `autoCreateWritableSquad` have no elevation path today, so this
column is simply always `NULL` on rows they create — nothing to stamp, not a gap. A
`project_slug_taken`/`squad_slug_taken` refusal's `detail` now carries `created_via_elevation_grant`
plus a `summary` string ("created by member X under elevation receipt Y", or just "created by
member X" when no elevation was involved, or a plain "no recorded creator" marker for a
pre-migration row) so an admin sees the FULL provenance picture — including the project's
`worker_name` in the project-limb detail, since that is the deploy target the planter chose —
before deciding whether to override. No FK to `elevation_grants`: consistent with every other
provenance column in this migration, not because the table is ever deleted (it isn't — only
`revoked_at` is set).

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
actor_member_id, slug_base, attempt_no, project_id, squad_id, refused_project_id,
refused_squad_id, bot_agent_id, disposition, failed_step, failure_reason, invited_count,
created_at` — `UNIQUE(tenant, slug_base, attempt_no)`. **`refused_project_id` /
`refused_squad_id` (round 2 of the successor, P0)** are set ONLY on a `'name_resolution'`
failure — the resource(s) found and refused that attempt — and schema-CHECK-enforced to be
NULL everywhere else; `project_id`/`squad_id` are the mirror image, schema-CHECK-enforced NULL
on every `'name_resolution'` failure and non-NULL everywhere else (including `'released'`,
where `project_id` names what was deleted and `squad_id` stays NULL). Migration `0166` carries the repo's standard "NOT
applied by this build — a human applies it" header (same as `0157`-`0165`); confirm
migration state operationally before assuming this table exists on a given deployment.
**`project_id` and `squad_id` are nullable as of the successor rewrite** — `NULL` only on a
`'name_resolution'` failure for whichever limb was never found or created (every other
disposition still always carries both, exactly as round 2 shipped). The SAME migration also
adds `projects.created_by_member_id` and `squads.created_by_member_id` (additive, nullable —
every pre-existing row lands `NULL`) — these are NOT columns on this receipts table; they live
on the resource tables themselves and are what `findAdoptGround` reads (see above).

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

**`disposition` has FIVE values (redefined by the successor — round 2's `'adopted'` covered
only the explicit-override branch; this fixes finding 7)**:
- `'created'` — BOTH the project AND the squad were newly created by THIS attempt. Narrower
  than round 2, which said `'created'` whenever project OR squad OR bot OR any invite was new.
- `'existing'` — the NARROWEST bucket: both resources matched a PRIOR team_bootstrap attempt
  WITH `disposition IN ('created', 'adopted')` (a genuine resumed retry of this team's own
  prior work — NEVER a `'failed'` receipt, see the P0 fix above), and this call made no bot and
  sent no new invite either — a true no-op replay.
- **`'adopted'`** — every other combination: a provenance-owned pre-existing row, an
  `adopt: true` override, a mixed create-one/adopt-the-other attempt, a cross-department
  project reuse, or a start-gate auto-created squad found by slug. An AUDITED or provenance
  outcome, always distinguishable from a genuine no-op replay.
- `'failed'` — the write phase did not finish this attempt, OR name resolution refused before
  any write. `project_id`/`squad_id` are real, already-committed rows for every disposition
  EXCEPT a `'name_resolution'` failure, where BOTH are ALWAYS `NULL` (schema-enforced — see the
  P0 fix above; refused resources go in `refused_project_id`/`refused_squad_id` instead).
  `failed_step` names where it stopped (`'edge_or_bot'` | `'invite_insert'` |
  `'name_resolution'`, the last added by the successor); `failure_reason` is a short,
  STRUCTURAL classification (`'unique_violation'` | `'write_failed'` | `'archived_project'` |
  `'project_slug_taken'` | `'squad_slug_taken'`, the last two added by the successor) —
  deliberately NOT the raw driver error text and NEVER an email address or other human PII, so
  this table stays safe to page through operationally without becoming a second place
  secrets/PII could leak from. The `'archived_project'` case now ALSO writes this receipt
  (round 2, P2) — the one refusal in the entire function that used to write none at all.
- **`'released'`** (P1-1, new) — an org-admin's `team_bootstrap_release` call deleted the named
  project after confirming it had zero edges. `squad_id` is NULL (a release touches only the
  project reservation); `project_id` names the now-deleted project — deliberately, since this
  row IS its audit trail.

## What the person sees

The tool's response: `{ disposition, receipt_id, project: {...Project fields, created},
squad: {...Squad fields, created}, edge_kept, bot: {id, slug, name, created} | null, invites:
[{id, url, email, capability, created}], duplicate_emails_in_request, credential_claim,
hermes_scaffold }`.

- **`project` and `squad` carry `created: boolean`** (same shape `bot` and each `invites[]`
  entry already used) — `false` on every adopted/idempotent-replay path, `true` only when THIS
  call minted the row. Both also carry `created_by_member_id` (successor addition) — `null`
  for a row created before migration 0166.
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

`tests/team-bootstrap.test.ts` — TWO `describe` blocks, every case through `invokeTool` on a
real SQLite D1 with the FULL migration chain applied (never a ToolSpec's `.run()` directly, and
never `teamBootstrap()` the core function called with a hand-built `AuthContext` `invokeTool`
would itself refuse — see the successor block's own header comment for why).

The original block (24 cases): registration; the happy path (project/squad `created: true`,
`edge_kept: null`, `duplicate_emails_in_request: []`, bot/invites/receipt/claim/scaffold all
present); idempotency on `slug_base` (adopted project/squad report `created: false`, no
duplicate invite, no second bot, disposition `'adopted'` on the second call — a new human was
invited, so it is not the narrower `'existing'` no-op case — TWO separate receipt rows, each
with its own `invited_count`); the agent-bound refusal; the AAGATE floor refusal; **the
squad-squat scenario end-to-end** (a capability-holding "attacker" squad matching a future
slug_base is refused `squad_slug_taken` with the owner AND `created_by_member_id` in the
detail, zero edges, zero agents, AND — successor addition — a `'failed'`/`'name_resolution'`
receipt IS now written, with `project_id: null` since the project limb was never attempted);
**`adopt: true` + org:admin** claiming that same squad, disposition `'adopted'`, receipted with
the claiming actor (Athena's round-2 sharpening; the receipt query orders by `attempt_no DESC`
to select the SECOND, successful attempt over the first refused one); **`edge_kept`**
preserving a deliberate `'read'` edge, never raised (P1-2); **`project_archived`** refused
before the squad is ever created, AND a race-window variant that archives the project between
the upfront check and the edge INSERT, proving the trigger-error mapping to
`'archived_project'` (P1-1); a stage-1 batch-failure case (injected failure on the edge INSERT,
not archived-status) asserting the edge/bot/invite are ALL absent but the failure IS receipted;
a partial-failure retry (batch fails on invite 3 of 5, injected) proving invites 1-2 persist,
the failed attempt is its OWN receipt row (never rewritten), and the retry's success is a
SECOND, new row disposition `'adopted'` (both project and squad already existed — `'created'`
fires ONLY when both are new by the SAME attempt) with `invited_count` counting only what THAT
attempt inserted (not a cumulative 5); within-call email dedupe (P2-1); a replay requesting a
DIFFERENT capability for a live invite reporting the STORED one (P2-2); a caller with no
`memberId` refused `actor_required` before any write (P2-3); `slug_base` length ceiling (44
chars) and `name` length ceiling; `slug_base` suffix validation; invalid human capability;
`bot.enabled: false` skipping bot creation and credential mint; `department_not_found` before
any write. The old rank-ceiling test (which called `teamBootstrap()` directly with
`capabilities: []`) is DELETED along with the guard it pinned — see the actor/step-4 sections
above for why.

The successor `describe` block (`'team_bootstrap successor …'`, 3 cases) reproduces
kasra-review's OWN round-2 reproduction end-to-end: a principal whose ENTIRE standing is
`lead` on its own squad (no admin anywhere, fixture cloned from `tests/
elevation-squad-lead-e2e.test.ts`) calls `check_in`, requests and receives a human-approved,
time-boxed elevation (`createElevationRequest`/`decideElevationRequest`), then plants a
project (`action:workspace_project`, org scope) or a squad (`action:project_lifecycle`,
department scope) through the REAL `project_create`/`create_squad` tools — never a hand-built
`AuthContext`. **P0(a)**: the org-admin's later `team_bootstrap` on the planted project's
`slug_base` is refused `project_slug_taken` naming the planter, the project's `name` is
unchanged, and — proving P1-A — no squad or edge was ever created either. **P0(b)**: same
shape for the squad, additionally asserting the planted squad is measurably EMPTY (zero
`agents`, zero `capabilities` rows) yet still refused — proving provenance, not emptiness, is
what gates adoption now. **P2-4**: a hand-planted `kind='home'` squad matching the derived slug
is refused `cannot_adopt_home_squad` even with `adopt: true` by org:admin, with a `'failed'`
receipt written. Both the provenance equality conjunct and the home-fence check are
mutation-proven load-bearing (each, independently weakened, turns the corresponding test RED).

Round 2 of the successor (the P0 in the ground-rule/refusal-receipt section above) added: the
squad-squat test now also makes a SECOND call with the same args and no `adopt: true`, proving
the refused squad's own `'failed'` receipt did not become adoption ground — still refused, zero
edges/bots, a SECOND independent receipt row (not a rewrite of the first); a legacy squad with
NULL `created_by_member_id` refused across three repeated calls, then adopted only once
`adopt: true` is passed; a cross-actor case — Admin 2, no `adopt: true`, cannot silently resume
Admin 1's genuine stage-2 write failure (Admin 1 themselves still can, via provenance). The
ground (i) disposition filter is mutation-proven load-bearing by the cross-actor case
specifically (the two-call/legacy cases still pass even with the filter removed, because the
refusal-receipt half of the fix — `project_id`/`squad_id` always NULL on a `'name_resolution'`
failure — is independently sufficient for THOSE two; the filter's OWN, non-redundant
contribution is the stage-1/stage-2 cross-actor case). A new `describe` block covers
`team_bootstrap_release` + `isSlugBaseReserved`: reserved while the project exists, released
(and the name genuinely reusable) after; refuses `project_has_edges` on an in-use project;
refuses `project_not_found`, an agent-bound principal, and a non-admin; `isSlugBaseReserved`'s
EXISTS join is mutation-proven load-bearing; a department-admin (real standing, not org-scoped)
with `adopt: true` is refused 403 on both limbs (refused by the tool's own floor — see Known
gaps for why the core function's OWN `isOrgAdmin` conjunct on the override cannot be pinned
separately); `team_bootstrap`'s own two creates are asserted to stamp `created_by_member_id`
with the acting admin; both `projects` and `squads` immutability triggers are mutation-proven
load-bearing (deleting/disabling the trigger turns the corresponding UPDATE-throws test red).

`tests/update-squad-tool.test.ts`'s slug-field `describe` blocks — rename, missing-suffix
rejection, in-department collision, existing-unsuffixed-slug left alone, AND the
reserved-name-rename requiring department:admin (squad-admin-only → 403; department-admin →
allowed; an UNRESERVED name still needs only squad:admin — P0c) — unaffected by the successor
rewrite, still green. `tests/project-start-gate.test.ts` — the auto-create-squad case (and its
retry-after-adding-an-agent), a second project reusing the same auto-provisioned department,
the pre-existing "a non-writable edge still refuses" case, and a NEW case (P3-2) asserting the
auto-created squad's `created_by_member_id` is stamped with the start-gate's acting member.

## Known gaps

- **No elevation/proposal path.** Unlike `create_squad`/`project_create`'s bounded-window
  `action:*` elevation limb, `team_bootstrap` is gated at standing org-admin only, and (as of
  the successor) has no per-human rank ceiling either — see the actor/step-4 sections above for
  why that guard was deleted rather than fixed. The elevation limb itself is a scope decision
  for Kasra-core/Hadi, not built here. The issue's own lighter lead-proposal variant (routing
  through mupot#1497's agent-proposed-invite machinery) is correspondingly also not built.
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
- **Cross-department residual: one project, two ADMIN squads.** `squads.slug` is
  `UNIQUE(department_id, slug)` but a project is global — the SAME `<x>-prj` can legitimately
  be adopted (via provenance or `adopt: true`) by TWO separate `team_bootstrap {slug_base:'x',
  department: D1}` and `{..., department: D2}` calls, each resolving `x-sqd` in a DIFFERENT
  department. Neither call is individually wrong (each department's squad genuinely doesn't
  exist yet, or is genuinely owned by that call's actor), but the end state is one project
  wired to two ADMIN squads (and potentially two bots) in two departments — receipted as
  attempts 1 and 2 on the same `slug_base`, indistinguishable in the receipt trail from an
  ordinary rename-retry. Not fixed here: closing it would mean either making `slug_base`
  resolution department-independent (a bigger structural change to how the squad name is
  derived) or refusing a second department's adoption of an already-admin-edged project
  outright — both are scope decisions, not bugs in the fixes above.
- **`team_bootstrap_release`'s edge check, not an exhaustive bot/human scan.** It refuses when
  the project has ANY `project_squad_access` row — chosen as a superset gate rather than
  separately checking for bots/agents/invites: every path that could place a bot or invite
  under this project goes through an edge first (team_bootstrap's own stage 1 wires the edge
  in the SAME batch as the bot), so "zero edges" already implies "nothing downstream of an
  edge exists either." It does NOT release a squad — only the project reservation — since
  `team_bootstrap` always re-resolves the squad independently by department+slug regardless of
  what happens to the project.
- **mupot#1495's own broader sweep is untouched**: `project_create`/`update`,
  `create_squad`, `create_department`, `create_agent`/`update_agent` suffix enforcement, and
  the existing-row backfill migration are explicitly a separate, later PR.
- **The `&& isOrgAdmin(auth)` conjunct on the `adopt: true` override is currently unreachable
  through the tool, same as the deleted rank ceiling** — `team_bootstrap`'s own floor
  (`hasWorkspaceAdmin`) provably entails `isOrgAdmin` on every path that reaches the core
  function (verified: every branch where `hasWorkspaceAdmin` is true also satisfies
  `isOrgAdmin`'s own logic). Unlike the rank ceiling, it is KEPT rather than deleted — Athena's
  stated reasoning for it ("never trusted from a caller whose own floor might one day be
  lowered") is a distinct, forward-looking justification the rank ceiling never had, and
  removing it changes no reachable behavior either way. No test claims to "pin" this conjunct:
  fabricating one would require calling `teamBootstrap()` with a principal `invokeTool` itself
  refuses — the exact defect class this successor exists to stop committing.
- **`seedSquadPack` (dashboard squad-pack seeding) and `src/projects/provisioner.ts`'s
  `createProject` call do NOT stamp `created_by_member_id`** — out of scope for this successor
  (neither was named in the review), so a squad/project created through either path lands with
  `created_by_member_id: NULL` and is adoptable by `team_bootstrap` only via the `adopt: true`
  override, same as any other pre-migration row.
- **PR #1510 is superseded, not merged.** This doc reflects `kasra/team-bootstrap-v2` — confirm
  that branch (or its successor) has landed, and migration `0166` has been applied, before
  assuming any of this is live on a given deployment.
