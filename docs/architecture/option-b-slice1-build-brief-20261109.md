# Option B slice 1 implementation plan — build brief

> For agentic workers: after explicit build authorization, use `superpowers:executing-plans` or an explicitly assigned bounded worker plan, task by task. The checkboxes below are future work, not completed actions. This PR is DOC ONLY.

**Goal:** One fresh home-pot agent receives a restricted credential through private CLI collection after one attributable human passkey decision.

**Architecture:** Retire /device in a separate earlier deploy. Then add home-pot-only consent, tenant-wide name reservations, mint-at-collection, a token-row class marker, the existing consenting-human clamp and a closed tool allowlist. Default off until independently reviewed and explicitly activated.

**Tech stack:** Existing TypeScript/Hono Worker, D1 migration chain, SESSIONS KV for anonymous TTL intents, existing secure-moment WebAuthn host and a local CLI credential store.

**Spec:** [Design #2373 at ec91e70f](https://github.com/Mumega-com/mupot/blob/ec91e70fc3046948bc581a4b8718b11f01231ebc/docs/architecture/option-b-agent-consent-design-20261108.md), refined by [entry conditions #2374](https://github.com/Mumega-com/mupot/issues/2374). Both round-2 lenses are GREEN **for planning**; no implementation/deploy authority follows. Source baseline inspected here: `7689a1f22422320925dd5e0509fda4b6330da044`. #2373 was still OPEN/DRAFT when this brief began; do not report its merge without a receipt.

Assignment: Kasra seq **9581**, delivery `ef69124e-183a-4fee-8b3e-afaf84423c03`, `beta-b-design-20261108-r2-result`. Athena authors this brief; Kasra owns Mupot core. Gate receipts are Mumega `agents/kasra/receipts/gate-pr2373-r2-lensA-20261109.md` and `gate-pr2373-r2-lensB-20261109.md`.

## Global constraints and refinements from #2374

- Home-pot only: the dedicated secure host uses the home Worker's `env.DB` and `env.TENANT_SLUG`. Refuse /t/<slug>, dispatch-namespace forwarding and foreign-pot intents. A per-pot RP/secure-host deployment is a separate design. This slice does **not** meet the stranger-own-pot or all-harness beta bar.
- Fresh identity only; no public existing-agent lookup, reconnect, rotation, refresh, attachment or operator authority. Anonymous labels never seed the assigned slug/display name.
- No `agents`, agent-member, capability or token row exists at approval. Approval records only consent and reservation. Create the active identity and all credential state in the collection transaction.
- The public name policy is tenant-wide, including inactive/archived agents and reservations. Never rely on `UNIQUE(squad_id,slug)`.
- Passkey UV by an active human on the dedicated secure host only. Passkey member = locked human = authenticated setup member. GET mutates nothing. No role-only, attached, sudo/elevation, Telegram callback or `human_origin` approval.
- Retain typed code, member scope and assigned-name display. Approval budget 10m; collection budget 5m after approval, absolute maximum start+15m. Bearer lifetime is an owner-selected integer `tokenTtlDays` from 1 through 30 (default 30), bound in the signed digest and revocable, with no automatic refresh.
- Preserve HTTP 401, exact `WWW-Authenticate`/`resource_metadata`, rich refusals and static trusted help guidance. No intent allocation from a failed MCP request.
- Refine the design's unbounded write requirement: live check once **per request**, and transactional reproof only for the closed sensitive list below. Ordinary allowed member writes accept a bounded check/write race; document it rather than touching every writer.
- Runtime and requester labels are untrusted; no owner login or secret in conversation, URL, page, logs, KV, D1 or receipts. A raw collected bearer exists only transiently in Worker memory and the CLI's private store.
- Migrations use `createSqliteD1()` + `applyAllMigrations()`. Allocate actual filenames only at build time above applied remote head, origin/main and all open migration PRs. `<next>` below is a filename allocation instruction, not a reserved number.
- All implementation slices require two independent lenses at exact head; mint, auth and migration slices may not proceed without them. Code CI, gate approval, merge, schema apply, deploy and activation each need distinct receipts and appropriate authority.

## Review focus

1. A slug or near-name collision in a different squad or inactive row must never disrupt wake/send resolution (task 2).
2. A missing consent join, unknown class value or alternate transport must not turn a restricted token into a legacy bearer (task 3).
3. A legacy owner email copied into a member profile must never supply issuance authority; expired capability and private-home inheritance must match canonical policy (tasks 1/4).
4. Approval at 9:59, lost collection response or audit failure must not strand an active agent or issue/replay a second key (task 4).
5. A one-click rollback to pre-retirement code must never reopen /device or reinterpret restricted keys; safe version selection is a deploy gate (tasks 0/6).

## File ownership and release order

All new paths named below are **proposed**, not existing files. Existing paths were checked at the source baseline. Do not edit shared dirty checkouts. One write owner per worktree; each slice produces its own PR, exact head, CI/gate receipts and rollback target. No automatic dispatch is requested by this brief.

| Order | Deliverable / files | Two-lens gate and rollout |
|---|---|---|
| 0 | Retire /device: `src/index.ts`, `src/auth/device-routes.ts`, `src/auth/device-grant.ts`, `tests/device-grant.test.ts`; new `tests/device-retired.test.ts`, `docs/operations/device-retirement.md` | Required: auth/credential surface. **Separate earlier authorized deploy R0**, before Option B migration/activation. |
| 1 | New `<next>_fresh_consent.sql`, `<next>_fresh_issuance_surface.sql`; `src/members/service.ts` types, regenerated `src/pots/schema-chain.generated.ts`; new `tests/fresh-consent-migration.test.ts` | Required: migrations and mint schema. Additive, inert on its own. |
| 2 | New `src/members/fresh-consent-store.ts`, `src/members/fresh-agent-name.ts`, `src/dashboard/fresh-consent.ts`; `src/index.ts`, `src/org/service.ts`, `src/agents/river-lead.ts`; new `tests/fresh-consent-setup.test.ts`, `tests/fresh-agent-name.test.ts` | Required: identity/tenant boundaries. Behind OFF gate; no credential issuance. |
| 3 | New `src/auth/fresh-consent.ts`; `src/mcp/index.ts`, `src/mcp/oauth-authorize.ts`, `src/auth/member-bearer.ts`, `src/auth/bound-agent-live.ts`, `src/types.ts`; new `tests/fresh-consent-auth.test.ts`, `tests/fresh-consent-tools.test.ts` | Required: all authentication paths. Deploy-capable restricted-token refusal floor R1, still OFF for issuance. |
| 4 | New `src/members/fresh-consent-collection.ts`; `src/members/service.ts`, `src/members/agent-connection.ts`, `src/secure-moments/routes.ts`, `src/secure-moments/store.ts`; new `tests/fresh-consent-collection.test.ts` | Required: mint, transaction, human approval. Integration stays OFF. |
| 5 | New `scripts/fresh-consent-connect.mjs`, `tests/fresh-consent-connect.test.mjs`, `tests/composition/fresh-consent.test.ts`; `docs/onboarding/harness-setups.md` | Required: credential handling and full composition. One supported CLI only. |
| 6 | New `docs/operations/fresh-consent-release.md`; authorized canary and release receipts | Two-lens integration gate + explicit human rollout approval. This brief neither deploys nor flips flags. |

R0 and R1 are recorded release SHAs/version IDs, not branch names. Any Option B rollback target must understand the class marker and retain /device retirement. R0 alone is not safe for live restricted keys until they are revoked.

## Task 0 — retire /device first

**Interfaces:** Replace every `/device` method/path with a constant retired response; no old decision/lookup/redeem code executes. Public guidance points to the existing supported, gated admin/OAuth recipe until Option B is available.

- [ ] Add route tests for code/token/preview/decision, GET/unfurl, old pending handles, flag-off and all accepted old content types. Assert no mint, no raw key, no state transition; use migration-chain DB for state assertions.
- [ ] Run `npx vitest run tests/device-retired.test.ts tests/device-grant.test.ts --maxWorkers=2`; record expected RED against the old unconditional mount.
- [ ] Remove the unconditional mount and unreachable weak handlers/services; replace old-device tests with retirement behavior. Keep a bounded explicit retired route ahead of catch-alls, returning 410 with what happened/who acts/next step. Do not change 401 middleware.
- [ ] Inventory `device:<user_code>` token IDs/expiry without raw secrets, invalidate pending and approved legacy KV handles and delete stored raw material under an authorized maintenance action. Revoke known uncollected/uncertain IDs. Old token lifetime is 3600s: wait at least 3600s from the last possible old issuance plus measured clock uncertainty, then prove no live `device:` issuance remains. Retain inventory/disposition receipts; never log KV raw values.
- [ ] Re-run tests, `npm run typecheck`, relevant 401 contract tests; mutation witness restores the mount and must fail retirement tests. Commit, obtain both exact-head gates and green CI.
- [ ] Only after separate merge/deploy authorization deploy R0, read `/health` for clean RELEASE_SHA and test retired endpoints live with no secrets. Record the version as the retirement floor before further rollout. No known consumers were found by the round-2 review; recheck source/plugin recipes before removal.

**Rollback:** Forward-fix retirement guidance or use a reviewed R0-compatible artifact; never restore the old mint endpoints. No Option B token exists at this stage. An inability to retire is a stop, not permission to leave a bypass open.

## Task 1 — persistence and issuance-authority query

**Interfaces / schema decisions:**

- `member_tokens.credential_class TEXT NOT NULL DEFAULT 'legacy' CHECK (... 'legacy','fresh_consent_v1')` on the token row itself; `consented_by_member_id` and `consent_intent_id` nullable for legacy, mandatory for the new class via a CHECK/trigger. Read the marker in the authenticating token query before any optional join. Unknown marker or missing provenance refuses.
- `fresh_consent_intents`: tenant/id, fixed setup/approval/collection deadlines, locked human/setup-member ID, future agent UUID/member UUID/token ID, home squad, assigned slug/name, code/recipient-secret hashes, status/version, `name_commit_nonce`, decision proof reference, issuance/revocation state and generation. Approved rows are not agent rows. No raw secret or token hash in audit.
- `fresh_agent_name_reservations`: unique `(tenant, canonical_slug)` and `(tenant, canonical_name)`; intent, future agent UUID, expiry and status. A reservation occupies a name, not an identity. A tenant-scoped `agent_name_revision` row is incremented by INSERT and name/slug UPDATE triggers; it guards the normalized-name snapshot used by task 2.
- Rebuild `agent_token_issuance_audit` to extend surface CHECK with **`fresh_consent`**. Copy all rows with original seq/id; preserve indexes, triggers and AUTOINCREMENT high-water mark. Compare row count plus bidirectional column equality before dropping the old table, abort on mismatch. Verify foreign-key behavior on real D1; do not rely on `PRAGMA foreign_keys=off` inside a transaction. Do not mutate old receipt contents.
- Collection uses `issuedBy.memberId=lockedHumanId`, `issuedBy.principal='member:'+lockedHumanId`, `surface='fresh_consent'`; this is durable principal attribution, not an invented human email or a current browser session. Link passkey decision proof and the existing agent-connection receipt separately.

New `collectionAuthoritySql()` in `src/auth/fresh-consent.ts` supplies **one exported production query fragment**. Tests execute that export, never a hand-copied substitute. Proposed exact SQL shape (numbered parameters: tenant ?1, locked human ?2, home squad ?3, server UTC now ?4):

```sql
EXISTS (
  SELECT 1 FROM members h JOIN squads sq ON sq.id = ?3
  WHERE h.id = ?2 AND h.tenant = ?1 AND h.status = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM agent_member_bindings b
      WHERE b.tenant = ?1 AND b.member_id = h.id
    )
    AND (
      EXISTS (
        SELECT 1 FROM capabilities c
        WHERE c.tenant = ?1 AND c.member_id = h.id
          AND c.capability IN ('admin','owner')
          AND ${CAPABILITY_LIVE_PREDICATE('c', '?4')}
          AND (
            (c.scope_type = 'squad' AND c.scope_id = sq.id)
            OR (sq.kind = 'work' AND (
              c.scope_type = 'org'
              OR (c.scope_type = 'department' AND c.scope_id = sq.department_id)
            ))
          )
      )
      OR (sq.kind = 'work' AND EXISTS (
        SELECT 1 FROM channel_capability_grants ccg
        WHERE ccg.member_id = h.id AND ccg.squad_id = sq.id
          AND ccg.capability IN ('admin','owner')
      ))
      OR (sq.kind = 'work' AND EXISTS (
        SELECT 1 FROM human_login_identities li
        JOIN users u ON lower(u.email) = lower(li.verified_email)
        WHERE li.tenant = ?1 AND li.member_id = h.id
          AND li.revoked_at IS NULL AND li.verified_email IS NOT NULL
          AND u.role IN ('admin','owner')
      ))
    )
)
```

The `${...}` slot is a TypeScript query-template substitution of the canonical exported expiry predicate, not literal SQL to ship. Keep the four numbered bindings fixed; fresh server time comes from `nowCapabilitySql()`. Never bridge role through invite-controlled `members.email`. Private `kind='home'` squads require an exact live capability; channel/org/department/role standing must not cross that boundary. The admin issuance floor subsumes lead creation, but existing entitlement, squad liveness and human-only checks still apply. No sudo/elevation qualifies.

- [ ] Write migration tests for old-row preservation, audit CHECK acceptance/rejection, token marker/provenance constraints and unique reservation conflicts. Write SQL/canonical-authority parity cases: exact admin/owner, department/org and channel inheritance, verified legacy role, revoked identity, invite-spoofed owner email, expired grants, suspended/welded member, private-home exact-only and wrong tenant. Use canonical JS checks without elevation.
- [ ] Run `npx vitest run tests/fresh-consent-migration.test.ts tests/fresh-consent-auth.test.ts --maxWorkers=2` for RED; allocate migration numbers only after checking current remote applied head, main and open PRs. Build the schema and shared query, regenerate the schema mirror with `npm run gen:schema-chain`, then rerun GREEN and migration-chain/workerd parity checks. Generated schema availability does not enable consent on foreign pots. Record each command's exit status.
- [ ] Mutation-prove tenant/expiry/verified-email/home-scope/human-status checks. Copy-verify audit with an empty table and nontrivial seq gaps. Gate both migrations and query at exact head before schema application.

**Rollback:** Additive columns/tables remain; issuance stays OFF. Never down-migrate or erase audit history. Failed copy verification aborts migration/rollout. Existing legacy behavior must pass unchanged-row regression cases.

## Task 2 — anonymous intent, explicit setup and tenant-wide reservation

**Interfaces:** `startFreshIntent(env, input:{runtimeNonce:string,appLabel?:string})` returns `{handle,collectionSecret,comparisonCode,approveBy,pollInterval:5}`; no agent argument. `lockFreshSetup(env, authenticatedHuman, handle, homeSquadId)` is a CSRF POST that returns the assigned UUID/slug/name and secure link. Neither function inserts an agent/member/grant/token.

Use SESSIONS KV with 600s TTL for anonymous intents; use namespaced home-tenant keys. Require the private secret for cancel. Durable D1 state begins only at authenticated setup with a conditional first-lock INSERT. Anonymous storage is not authorization; replayed KV cannot reopen a terminal D1 intent. Only the home Worker resolves these handles. Server-assigned slug is `agent-` plus 12 random lowercase hex characters; display name is `Agent ` plus that suffix. User labels are separately escaped; neither chosen field comes from them.

At reservation and collection, compare every existing agent slug AND display name across this D1, including inactive/archived rows. Use NFKC/casefold/punctuation-stripped skeletons and reject skeleton equality or edit distance <=1; reject non-ASCII submitted name overrides outright (slice 1 has no editable name). Store canonical values and repeat against reservations. A random conflict retries server generation at most 3 times; then return owner-actionable name conflict without exposing the occupant.

Reserve with unique keys and a guarded NOT EXISTS against `agents`. `prepareFreshNameCheck(env)` reads the name-revision counter, all tenant agent names/reservations, then the counter again; retry if the revisions differ. It returns the normalized conflict result plus the stable revision. The first conditional lock/collection statement checks that revision and claims the intent with a fresh `name_commit_nonce`; later statements depend on that exact winning nonce rather than rereading a counter advanced by their own triggers. D1 batch serialization prevents another transaction interleaving. Consume only this intent's reservation; an absent claim makes every dependent write a no-op, and a failed invariant uses the existing SQL commit-guard pattern to abort the whole batch. Retry a stale snapshot at most 3 times. Reservation INSERT/UPDATE/DELETE also increments the counter. This converts NFKC/edit-distance checks into a guarded snapshot, not a second Unicode/Levenshtein implementation inside SQLite. Add forward-only exact slug collision/reservation INSERT/UPDATE triggers on agents; permit only the matching reserved future UUID during collection. All legacy create/update name writers use the same snapshot-and-revision guard, including display-name normalization, so no concurrent legacy writer can take the reserved name. At baseline the name-writing paths are `src/org/service.ts` (create/dynamic update) and `src/agents/river-lead.ts` (direct seed); wire or safely refuse both under the reservation policy. `src/pots/service.ts`/the generated schema are foreign-pot bootstrap, outside the home-pot pilot; prove they cannot enter its DB. Recheck that bounded writer inventory before code rather than assuming a caller list is timeless. Do not add a unique index that fails on historical twins or rename/delete existing agents; forward guards reject new conflicts and any unresolved race. Record the migration that installs the revision and reservation triggers.

- [ ] Add tests for cross-squad/inactive slug match, near-name/display match, reservation race, legacy creation/update racing collection, 3 exhausted generation attempts, old duplicate inventory, no row before collection, and known/unknown agent fields returning identical unsupported-field responses without lookup.
- [ ] Add GET/unfurl-no-lock, wrong tenant/foreign host, explicit CSRF setup, co-admin first-lock, private cancel and replayed anonymous-intent cases. Per-IP anonymous rate limits plus KV allocation limits do not promise Sybil resistance. Do not invent reserved authenticated start capacity: all starts are anonymous. A human can retry through existing supported admin setup; public flood and first-lock hostage are bounded residual DoS, accepted by #2374.
- [ ] Run `npx vitest run tests/fresh-agent-name.test.ts tests/fresh-consent-setup.test.ts --maxWorkers=2` RED → implement → GREEN. Mutation-prove cross-squad check, lock-on-GET refusal and reservation ownership. Gate identity/migration trigger changes.

**Rollback:** Disable start/setup and expire/release unused reservations without deleting agents. Keep historical duplicate inventory. No public auto-retry; human or runtime gets exact expiry/cancel/recovery guidance.

## Task 3 — live clamp plus closed allowlist

**Interfaces:** `resolveFreshConsentAuth(env,tokenRow)` reads class from the authenticating row and returns live restricted identity/capabilities or refused/unavailable. `freshConsentToolAllowed(tool,args,auth)` is a closed allowlist. `collectionAuthoritySql()` is also reused for live issuance-standing verification; provenance supplies `consentedByMemberId`.

Reuse `resolveConsentedAgentCapabilities(env,agentId,consentedByMemberId)` instead of writing a second rank clamp. Its current admin eligibility limb does not cover legacy-role-only humans: make its eligibility use the verified role-aware canonical helper, retain scope/home rules, and test existing OAuth callers. Its memo remains request-local. Layer the fresh shape/identity checks and allowlist around it; do not change ordinary legacy token behavior. Boot/orient must truthfully report this restricted class, the allowlist, and peek-only inbox access rather than generic minted-token consumption authority. Require exactly one effective member grant on the home squad, no gate/surface/delegation rows and the identity values below. Later added authority makes this class refused, never inherited.

**Closed allowed tools:** `boot_context`, `status`, `orient` (self only), `task_list` (self/home only), `task_get` (own assignment/home only), `inbox` (`peek:true`, own only), `task_update` (own assignment, only open→in_progress, no other fields), `task_submit_result` (own in-progress assignment, normal artifact/gate rules). Deny **every other tool**, including newly registered future tools. Allow initialize/list/notifications as protocol operations, not authority; tools/list exposes only this subset. No task verdict or self-completion shortcut. Acceptance is a submitted first-task result with an independent gate, not a claim that the agent accepted its own work.

MCP and `/actions/<allowed-tool>` share that check after canonicalizing aliases and before any handler/elevation/elicitation. Deny all other authenticated REST, events/streams, token-hash APIs, legacy body shapes, profile door, refresh/exchange/attach and alternate credential stores for this class. Public health/discovery behavior remains public. Apply marker/live checks in MCP and `member-bearer.ts` before any shortcut; stream admission refuses this class entirely. Missing or unknown marker/provenance is not a legacy fallback.

The **closed sensitive conditional-write list** is: (1) fresh setup lock/reservation and name mutation, (2) approve/deny/cancel, (3) collection/token issuance/revoke-only, (4) generation/consent revocation. Those writers embed the shared eligibility/status predicates in their transaction. All other sensitive tool families—verdict/gates, structural/delegation writes, surface caps, owner-call, secret/host-key requests, registration, mint/rotation, deploy, harness/presence control and identity updates—are not allowlisted and cannot run, so no per-writer retrofit of ~133 tools is planned. Enumerate actual `attachedAuthority` consumers in the build receipt (about 22 files at baseline) and probe each by calling its real route/tool; the old five-file header is not coverage proof.

Ordinary allowed task_update/task_submit_result use the per-request live check plus existing task-state checks, accepting a revocation race between check and write. A request already admitted may finish that member action. Record this residual; the next request fails. This is the bounded round-2 refinement, not an atomic-all-writers guarantee.

- [ ] Run `npx vitest run tests/fresh-consent-auth.test.ts tests/fresh-consent-tools.test.ts tests/agent-bound-oauth-consent.test.ts tests/member-bearer.test.ts --maxWorkers=2` with cases for missing join/marker, extra grants/gates/identity fields, human demotion, role-only owner, database failure, alias/action/REST/stream bypass and a newly registered unlisted tool.
- [ ] Implement RED → GREEN; mutant removal of marker fail-closed, allowlist or human clamp must fail. Verify ordinary allowed task work and legacy/OAuth regressions. Two-lens gate required before deploy R1.

**Rollback:** Issuance stays OFF; revert to a reviewed R1-equivalent refusal build. Before any rollback to code lacking the marker, revoke all class tokens by their token-row marker AND intent/generation inventory, wait for in-flight requests to drain and prove zero live class tokens. No schema deletion or silent downgrade.

## Task 4 — secure approval and atomic collection

**Interfaces:** `approveFreshIntent(env,humanProof,intentId,typedCode)` commits only decision/status/deadline. `collectFreshCredential(env,handle,collectionSecret)` is a private HTTP operation, not an MCP tool: conditional creation + token mint + audit + consume, raw returned once. `cancelFreshIntent(...)` cancels pending/approved or revokes its exact issued token, never issues another.

New identity values are explicit: owner_member_id, attach_designated_member_id, parent_agent_id, owner, qnft_ref, capabilities/skills/purpose/model_fallback/death_condition profile fields **NULL**; kind=`work`, autonomy=`draft`, role=`member`, budget_cap_cents=0, owner_call_owner_revision=0. No fleet/host/runtime binding is created. Model uses the schema's ordinary default as a configuration placeholder, not a runtime claim. Approving human exists only in consent/token/audit attribution, not owner columns. Per-use shape checks include these identity fields. No approval row or roster agent before collection.

At collection generate fresh UUIDs/raw randomness in memory, then compose one D1 transaction with the exact authority query, live consent/deadlines, fixed tenant, name reservation ownership and anti-collision guards; insert active agent, fresh member/weld, one member home grant, marked token/provenance, `agent_token_issuance_audit` and connection receipt, then consume. Shared mint gets an explicit fresh-only mode that omits lane-gate INSERT atomically. Never use ordinary mint then remove a gate later. Use the existing SQL commit-guard pattern to abort the batch if any required write did not land; `meta.changes`/`assertBatchWritten` verify the outcome but a JS assertion after a committed batch is not a rollback mechanism. A losing initial claim makes all dependent writes no-ops. No agent/token on a failed audit or racing loser. Receipt state says credential issued, not authenticated/completed.

Secure page shows server-assigned slug+UUID, member scope, exact allowed reads/writes (own tasks, orientation, own inbox peek, task result submission; no gates/secret requests), untrusted runtime label, locked human, lifetimes and typed-code field. Reuse exact dedicated-host/RP, UV-human, single-use challenge, CSRF and safeReturnPath enrollment/setup return logic. `SECURE_MOMENTS` off/misconfigured means no link, no cookie-only fallback. Refuse foreign pots; no dispatch routing on the RP host.

- [ ] Run `npx vitest run tests/fresh-consent-collection.test.ts tests/secure-moments.test.ts tests/composition/secure-moments-host.test.ts --maxWorkers=2` RED → implementation → GREEN.
- [ ] Cover double collection/tap, approve at 9:59/full five-minute collection, denial/cancel/collection races, agent/member/grant/audit insert failure, authority removed before batch, verified-role revoke, wrong member/code/host/RP, replay and lost response. No raw key at rest or in logs. Losing transaction cannot return a key.
- [ ] Mutation-prove lane-gate suppression, collection authority SQL, identity NULLs, audit failure rollback and consumed-state guard. Gate mint/auth/schema integration with two lenses; issuance remains OFF.

**Rollback:** Disable generation/collection. No key exists for approved-uncollected requests. Revoke marked issued IDs, preserve evidence and inert identity records, release unused reservations. Keep /device retired and restricted-class rejection live.

## Task 5 — private CLI delivery and composition

**Interfaces:** `scripts/fresh-consent-connect.mjs` runs outside model tool-result logging. It stores its collection secret in a 0600 file, prints only link/code/deadline, polls at >=5s, writes a collected token atomically to a 0600 protected file and configures an environment-variable binding, never a bearer in TOML/argv/transcript. The command is owner-run local setup; the agent/model never receives raw output. No standing daemon or auto-wake claim.

- [ ] `node --test tests/fresh-consent-connect.test.mjs`: fake transport tests assert no secret stdout/stderr/argv, storage mode, bounded backoff, terminal denial/expiry, crash-after-collection uncertainty and revoke-only recovery. No silent recollection/re-mint or fresh-identity loop.
- [ ] `npx vitest run tests/composition/fresh-consent.test.ts --maxWorkers=2`: real migrated router path proves request→setup→passkey→collect→self boot→own task in_progress→result submission. An independent gate may later accept it; do not fake a completion verdict.
- [ ] Run targeted suites/typecheck, required CI and the sensitive mutants. Verify unchanged 401/challenge and rejected legacy endpoints on both normal and flag-off paths. Commit and obtain the integration gates.

**Rollback:** Stop CLI polling on terminal states, revoke uncertain issuance, remove only its own credential binding after revocation proof. Use authenticated existing-admin recovery; no secret copying, borrowed owner login or public existing-agent reconnect.

## Task 6 — authorized release, proof and safe rollback

- [ ] Record R0 retirement deploy plus legacy-drain receipt. Record applied migration head and R1 marker-aware safe rollback artifact. Every build/gate/CI SHA must match the authorized release tree.
- [ ] After independent two-lens integration GREEN and explicit human merge/schema/deploy authorization, stage the complete home-pot feature OFF. Read health SHA; rehearse rollback with restricted tokens so none can become ordinary bearers.
- [ ] Obtain separate secure-host/flag/canary approval. One human home-pot CLI cold walk records instruction/setup/login/code time, passkey decision, issuance-audit/connection IDs, authenticated UUID, submitted first-task result and independent acceptance if available. Record minutes/stuck points; Hadi phone and foreign-pot/native-harness work remain separate.
- [ ] Flip only after that authorized canary is accepted. Any identity, authority, receipt or secret-handling failure disables generation, refuses collection and revokes the class generation before changing code. Do not cross the R0 floor or deploy a pre-marker artifact while a restricted token is live.

**Rollback receipt:** exact release/version selected, generation disabled, pending/approved terminal IDs, marked issued-token revocations, zero-live-token query result, in-flight drain, reservations released, identity/audit rows retained, `/device` still 410 and 401/OAuth challenge unchanged. No prior grants need restoring. No automatic re-enable.

## Brief self-review and evidence boundary

Coverage: #2374 name/reservation/near-name and no-agent-before-approval → tasks 1/2/4; home-pot host limit → tasks 2/4/6; buildable clamp/allowlist/NULL identities/SQL → tasks 1/3/4; all P2s → R0, token-row marker, collection-only activation, audit rebuild, explicit consent scope and bounded residuals. Sign-in return uses existing safeReturnPath; no parallel continuation store.

The brief's function names/schema/migrations are proposed interfaces, not shipped capabilities. Source-reference and document checks are the only checks performed by this doc-only PR; implementation commands above are NOT reported as run. Anonymous flooding, co-admin approver lock (10m expiry), remote phishing that yields only the displayed member actions, and ordinary-member check/write races are accepted bounded residuals from round 2, not proof of an unphishable system. Exact resolving evidence is the gated implementation, mutation witnesses and authorized walk receipts above.
