# Option B: fresh agent consent and private credential collection

Status: **DRAFT DESIGN ONLY — revision 1, awaiting round 2 of 2.**

Author: Athena, authenticated Mupot UUID `a9423609-e3bf-4797-8af8-4b9b7aecdf16`,
Codex/Orca following Hadi's 2026-11-08 move from Pi. Assignment: Kasra seq 9566,
`beta-b-design-20261108`, blocker `7e0cb92d`. Revision: seq **9569**,
`beta-b-design-20261108-r1`, read 2026-11-09.

Both independent lenses **BLOCKED** the previous head `57cc47d0`. This revision
replaces its existing-agent public start, unenforced bearer-ceiling promise,
approver-on-view freeze, encrypted delivery envelope and bespoke continuation.
The old verdict remains valid for that head. Revision does not constitute a
new gate verdict. Kasra owns core implementation. Order remains **drafts → two
independent lenses → builds → signs → flips**; this PR changes one document only.

## Decision and acceptance boundary

Use **fresh identities only**, mint **at collection**, reuse existing login
`return`, and **retire the legacy /device flow** in the same future rollout.
No unauthenticated request can name, reconnect, rotate or acquire an existing
agent. The owner sees **Create a NEW agent**, never **Reconnect Kasra/Athena**.

The resulting credential is the fresh agent's own separately revocable key,
not the owner's login. The only authority created is one home-squad member
grant on a new agent member, with **no lane gate**. This requires explicit
changes to the shared mint and authentication paths described below; current
standalone tokens do not have that restriction. Do not infer it from page copy.

Proud-bar source: Mumega `agents/kasra/docs/beta-onboarding-proud-bar-20261107.md`,
items 3–5: actionable refusals, an agent-owned key without human secret copying,
and one attributable owner approval. Retain code entry before the passkey tap.
One **authority decision** does not mean one gesture for cold signup, login,
context selection, code entry or passkey enrollment. Time all of these in the
walk; do not lower the existing approval bar to make the copy true.

First supported path is one CLI with verified private credential storage,
inside a pot where its human already has creation and issuance authority.
A fresh customer without that authority uses the existing human pot-onboarding
path first. No public self-grant of admin or cross-pot provisioning is added.
Native OAuth, Telegram completion and harness-wide walks remain unproven until
tested separately; the CLI slice alone does not close the all-harness beta bar.

## Source facts: what reuse does and does not provide

Pinned source baseline: `7689a1f22422320925dd5e0509fda4b6330da044`. Source
observations were rechecked for this revision; they are not deployment claims.

| Surface | Verified fact and consequence |
|---|---|
| `src/members/service.ts:641` | Non-rotation mint upserts `gate:<slug>`; default reuse would violate this design. A fresh-consent mint mode must omit that grant atomically, not delete it afterward. |
| `src/mcp/index.ts:850`, `src/auth/member-bearer.ts` | A standalone workspace bearer uses the welded member's grants; `member_tokens` has no capability-ceiling column. No live approving-human clamp is supplied by these paths. |
| `src/auth/attached-ceiling.ts:1` | Attached-seat ceilings and identity-keyed restrictions exist for attachments, not ordinary workspace bearers. Its list of gate, delegation, surface-cap and human-origin paths is the required coverage inventory for the new credential class. |
| `src/members/agent-connection.ts:364` | Existing creation and credential-issuance predicates, new/existing target models and connection receipts can be composed. Issuance still requires admin authority in the exact home context. Do not call an internal helper to skip that requirement. |
| `src/members/service.ts:658` | Supplying `issuedBy` writes `agent_token_issuance_audit` in the mint batch. This row is required, not optional telemetry. |
| `src/auth/device-grant.ts:239`, `src/auth/device-routes.ts:33`, `src/index.ts:295` | Existing /device is mounted unconditionally: role bypass, no passkey, public existence lookup, tenant-global pending cap, plaintext raw key in KV, non-atomic decisions/redemption and no issuance-audit actor. It cannot remain as an alternate door. |
| `src/secure-moments/config.ts:1` | `SECURE_MOMENTS` is OFF by default. Its validated dedicated host is the exact WebAuthn RP ID and must be outside colony/pot and Access-approval hosts. `src/secure-moments/routes.ts:4` requires an active human's user-verified passkey; that host sets no cookies. |
| `src/members/seat-attach.ts:493` | The function is `decideAdmissionDirect`, not `decideAdmission`. Code entry is checked before approval; harness scope is not granted through its dashboard path. Keep the passkey-only harness choice in `decideSeatAdmission`. |
| `src/auth/index.ts:234` | `safeReturnPath` and existing OAuth-state/email login return handling already exist. Reuse them, not a new continuation store. |
| `src/auth/unauthenticated-guidance.ts:58` | Guidance is presentation-only; the existing HTTP 401 and OAuth challenge are copied. Preserve that contract. |

There is no safe shortcut that consists of a new page around the current mint.
The minimum implementation includes a restricted fresh-consent mint mode,
consent/token provenance, shared live eligibility checks across authentication
surfaces, identity-keyed exclusions, serialized collection, and /device removal.
These are missing requirements, not claims that existing machinery enforces them.

## End-to-end flow and authority transitions

1. **Public start, fixed tenant.** A dedicated new-consent start accepts a runtime
   nonce and optional untrusted app label, not an agent reference or requested
   capability. Tenant is resolved once from the canonical server routing context
   and stored immutably. Return an opaque intent handle, separate 256-bit private
   collection secret, comparison code, deadline and five-second poll interval.
   Only secret hashes are stored. No agent lookup, identity, standing or bearer
   is created here. Known and unknown submitted agent names receive the same
   constant unsupported-field response without database lookup; no existing-agent
   lookup endpoint remains in this flow.
2. **View, login and safe return.** The consent link opens only the validated
   dedicated secure host. GET/unfurl/view grants nothing and locks nobody. If new
   identity context setup needs login, an explicit navigation goes to the pinned
   dashboard origin with a validated relative `return` to a fixed setup route.
   After valid login, the same intent is resumed; setup selects only squads in
   its fixed tenant. It then navigates back to the pinned secure host. No approval
   UI or decision endpoint is hosted on a pot, colony `/t/<slug>` or dashboard.
3. **Explicit owner setup POST.** From the signed-in human's dashboard, an
   origin-checked CSRF POST selects the home squad and a fresh identity label,
   binds the runtime intent/secret hash and locks that session's human member as
   approver. Check exact creation and mint authorization using canonical role-
   and grant-plane predicates, e.g. `memberCanOnSquadAuth`-style resolution; do
   not copy the blanket `auth.role === owner/admin` shortcut from /device.
   No agent/attached bearer, sudo, elevation or `human_origin` assertion can run
   this human setup POST. It prepares a request, not an approval or live grant.
4. **Reserve, never adopt.** Allocate a fresh server UUID and a bounded reservation
   for a new slug in that tenant/home squad. The slug can never resolve to an
   existing identity. A collision is shown only after authorized context setup:
   choose a different name, do not reuse the occupant. The first authorized setup
   POST wins conditionally; no GET or viewer can freeze itself as approver. After
   locking, another admin cannot replace the human. Scope/name/home/recipient
   changes invalidate the challenge and require a new intent. A mistaken lock
   expires or is cancelled with the runtime secret; it cannot seize an agent.
5. **One human authority decision, on the secure host.** Show fixed tenant/pot,
   home squad, new UUID, untrusted agent/app labels, locked human, member-only
   scope, credential lifetime and who will collect it. The owner types the code
   obtained from the runtime's independently opened original conversation, then
   taps **Create new agent with passkey** or **Deny with passkey**. Do not prefill
   the code from the URL or a forwarded Telegram message. The code is phishing
   friction, not proof of a trusted runtime: a malicious requester can know it.
6. **Approval commits consent, not a key.** A same-origin/CSRF-protected,
   single-use UV passkey assertion binds intent/version, locked human, tenant,
   fresh UUID, home, recipient secret hash, code check, fixed member scope and
   lifetime. Its active HUMAN member must equal the locked approver and the
   server-recorded authenticated setup-session member. The dedicated secure host
   sets no session cookie; it checks that recorded identity, not a caller-supplied
   human field. Reject an agent member's passkey, mismatched member or expired
   setup binding. Re-evaluate human eligibility in the conditional commit.
   Approval atomically records the human decision, promotes the new identity to
   active and creates its fresh member binding with exactly one member home row;
   no token, lane gate, other access or delivery envelope exists yet. A duplicate
   tap cannot create a second identity. Deny creates no identity, grant or key.
7. **Collection rechecks and mints once.** The private runtime polls over TLS,
   never through a model-visible tool result. At collection, a single conditional
   transaction checks approved/non-revoked status, tenant, recipient secret,
   collection deadline, active agent/member, active locked human with CURRENT
   creation/issuance authority in the home squad, and the exact restricted
   authority shape below. It inserts one token hash and mandatory issuance audit,
   links the connection receipt and advances approved → consumed, or commits none.
   Generate raw randomness only in the request's memory; only the winning
   transaction returns it. No plaintext/encrypted raw bearer or delivery key is
   stored in KV, D1, a transcript, page, Telegram message or receipt. No Worker
   envelope-encryption key or HPKE key custodian is needed for this chosen design.
8. **Authenticate and do first work.** The runtime writes the raw key directly to
   protected credential storage, reconnects and calls `boot_context`, `orient`,
   then its first authorized task. Verify UUID/scope against the consent and
   `agent_token_issuance_audit`/connection receipts. Approved, consumed,
   authenticated, messaging verified and first-task completed are distinct facts.

Only the locked human with that passkey may Approve or Deny. The runtime's
private secret may Cancel its own unconsumed request; it cannot approve or deny
for the human. Unknown viewers, other members and Telegram callbacks cannot
terminate requests. Invalid proof never consumes approval. Repeated collection
never returns the raw key again. A response lost after commit is delivery
**uncertain**, not failed issuance: the runtime can cancel/revoke that exact
issued token using its existing private request secret through a revoke-only
endpoint. It cannot mint a replacement there. Recovery then uses owner-initiated,
authenticated existing-agent recovery under existing gates, not the public start.
Do not auto-create another identity or train the owner to approve another link.

## Restricted fresh-consent credential: enforceable contract

This is a proposed explicitly marked token class, linked by token ID to durable
consent provenance; it is **not** an existing per-token ceiling feature. The new
mode is usable only for identities created by this exact approved intent. It
cannot accept an existing UUID, rotate another key or reuse an existing member.
Reuse shared weld/token/audit statements with an explicit mode that suppresses
the lane-gate INSERT inside the same atomic batch. Default legacy mint behavior
is outside this change. Post-mint gate deletion is not an acceptable substitute.

The restricted identity has exactly one effective live capability: member on
the consent's exact home squad, including checks against inherited department/
org standing. It has no gate grants (including its own lane), surface caps,
operator delegations, owner-keyed approval authority, mint/deploy authority or
other access. Check this state at identity promotion and collection. An
unexpected row, unresolved inheritance or authority lookup failure refuses the
transition; do not downgrade, delete or overwrite existing grants to make it pass.

**Every use** of this class must revalidate the consent, issuing generation,
locked human's active/current issuance authority, active agent/member, token
expiry/revocation and the same exact authority shape. Broader grants added later
make this credential unusable; it never inherits them. The owning human must
use an existing separately gated upgrade/reissue path if broader access is wanted.
Do not change the token's class or turn a missing consent join into a legacy
bearer. A missing/unavailable required lookup fails closed, preserving the
existing invalid-credential versus retryable-unavailable response conventions.

Implement one shared predicate and invoke it in both MCP authentication and
`src/auth/member-bearer.ts`, including REST, actions, token-hash liveness checks,
stream admission AND push/use-time rechecks. Connection-entry validation alone
is insufficient. Mutating operations must reprove the relevant consent/authority
predicate in their conditional write so revocation cannot lose a check/write race.
The following identity-keyed paths listed by `attached-ceiling.ts` must explicitly
refuse this class even if a later identity grant appears:

- `src/gates/principal.ts`: surface/approval-queue principal resolution.
- `src/tasks/index.ts`: gate capability, task gate lane, `verdictPrincipal`, and
  assignee self-completion shortcuts; no gate authority via agent identity.
- `src/auth/capability.ts`: surface-cap authority.
- `src/operators/chokepoint.ts`: structural writes/delegations and bypasses.
- `src/mcp/index.ts`: delegation-floor bypass, owner-keyed acts and `human_origin`.
- Sudo/elevation, credential mint, refresh/exchange and attach/harness reissuance:
  this class cannot use a second credential or admission door to shed restrictions.

This coverage is an implementation entry condition. A provenance row with no
executed guard on any one of those paths leaves the P0 open. It must be tested
and mutation-proved across all doors before activation. This design does not
claim existing workspace bearers become safe by choosing capability='member'.

## Link, host, time and abuse contracts

The link carries a versioned secure-moment route and random opaque handle/token,
never a raw key, collection secret, prefilled comparison code, scope JSON,
callback host or user-controlled tenant selector. Store link/secret hashes;
tenant is resolved from a server-side record before opening its tenant DB.
The secure service's opaque lookup/routing record is authoritative; client
`/t/<slug>` paths and link hints cannot redirect the approval to a different DB.
If the deployment cannot resolve that route safely, refuse the feature.
No public pending list. Labels are escaped untrusted text, not instructions.

**Host and human-proof requirements are unconditional.** `secureMomentsStatus`
must be on with a validated dedicated `SECURE_MOMENTS_HOST`; exact HTTPS origin
and RP ID checks remain intact. Tenant-controlled pages must never host the
consent or decision. OFF (the default), missing host, related/invalid host or
unavailable proof infrastructure means feature refused, no consent link emitted.
There is no cookie-only Allow, org-admin role bypass, attached chat approval,
owner_sudo/elevation approval, Telegram callback approval or harness-attested
`human_origin` substitute. Activation requires separate human authorization;
this doc does not turn on SECURE_MOMENTS or any rollout flag.

Proposed budgets for the round-2 design gate:

| Object | Bound |
|---|---|
| Unapproved intent/setup | 10 minutes from start; absolute server deadline, never extended by GET/login/poll. |
| Passkey challenge | Existing secure-moment maximum, further capped by remaining approval deadline. |
| Collection | Fixed 5 minutes AFTER approval; approval must occur before start+10m, so collection ends no later than start+15m. A late valid approval still gets five minutes. |
| Issued bearer | At most the existing standard 30-day expiry (`src/auth/token-lifecycle.ts:58`), displayed and bound in consent; owner may shorten. Independently revocable, no non-expiring option, no automatic refresh/exchange. |
| Receipts | Existing audit retention; strip secret material, retain decision/issuance/revocation links. |

The 30-day choice replaces the first draft's hourly reapproval loop; it is a
bounded design proposal matching standard agent-token policy, not permission
to lengthen existing /device tokens. Retirement replaces that separate weaker
protocol, rather than silently upgrading its old requests or credentials.
An approaching expiry warns the runtime/owner through existing status surfaces;
renewal is owner-initiated on a signed-in surface under existing gates, never
a repeated unsolicited public approval link. Reviewers must approve this budget
before build; timed cold and renewal walks are required before customer claims.

Public quotas are per deployment-controlled source-IP/rate bucket AND requester
secret/session where available, not a client-supplied label. Use bounded low-cost
unapproved records, short TTL, per-source throttling and global infrastructure
protection; authenticated owner requests have a separately reserved bounded
budget. Do not reuse the tenant-global eight-request quota: unauthenticated
requests must not consume all capacity for an authenticated owner. Document
measured limits/load behavior before rollout. Distributed flooding can still
cause service unavailability; return bounded 429/retry guidance, never grant
access to work around it. No request supplied with known/unknown agent names
can alter output based on that identity's existence.

## Login return, harness scope and Telegram

Card `a97a2efb` / checklist #8: use existing `safeReturnPath`, OAuth-state `return`
and the email login-return handling for the fixed dashboard setup route with an
opaque intent handle. No new continuation object. A relative path cannot jump
to the secure host: after authenticated setup the server constructs navigation
from `momentUrl` and validated secure-host configuration. Never accept an
arbitrary return host, protocol-relative URL or callback supplied by the runtime.
Login success returns to setup for this intent, not Home, and never approves it.
No passkey yet: authenticated Account enrollment using the existing separate
enrollment ceremony, then return to the same live setup/secure link. Never
register a passkey from a bearer approval link. Expiry asks for a new request.
Test Google/email/Telegram login, account switches and multi-tab returns; a
mismatched human must not replace the locked approver. The secure host itself
stays cookie-free and the passkey remains the deciding identity.

Checklist #10: first slice issues one standalone fresh-agent credential, **no
harness-wide admission**. Existing chat/harness admission behavior remains
separate. `approval_bound_to_other_chat` does not become automatic reassignment.
A later harness integration must explicitly bind human + agent + exact OAuth
installation/grant + harness, with the existing passkey choice between this chat
and this install's chats. Keep no Full and no gate inheritance in harness scope;
revoking install/admission ends reuse. Do not weld an unbound harness token to
an agent, export a standalone bearer through a chat, or convert this restricted
credential into an unrestricted attachment. Existing-agent reconnection is a
separately gated follow-up requiring a live agent credential/attachment or
registered-runtime-key proof (`register_agent_key`), or an owner-started pairing
from a signed-in surface; it is not reachable via public fresh consent.

Telegram only opens the same dedicated secure-host request. Bot callbacks,
forwarded messages and Telegram identity alone cannot Approve/Deny. Any prior
verified member association must still match the locked human and UV passkey.
The code must come from the original runtime, not a forwarded button. No native
Telegram completion or private token delivery claim without its own recorded
walk. Native OAuth clients retain existing code/PKCE and exact redirect checks;
no token ever travels through model-visible `reveal_credential_claim` output.
A harness lacking tested private credential storage remains explicitly unsupported.

## Retire /device, remove steps, preserve refusals

Retirement is required in the **same first implementation/rollout**, including
public `/device/code`, `/device/token`, code preview and Allow/Deny endpoints.
Remove the unconditional `app.route('/device', deviceApp)` issuance path or
replace all of those routes with non-mutating retired guidance. This applies
when secure moments are off too: off is not fallback to the old flow. Resolve
all old KV namespaces at cutover: invalidate pending/approved redemption state,
delete stored raw material, and revoke every uncollected or uncertain legacy
issuance by recorded token ID. If legacy IDs cannot be fully inventoried, hold
activation until accounted for. Keep historical evidence; no blind KV purge.
Already delivered legacy keys are inventoried for separate owner disposition,
not silently relabelled as restricted keys. No new code is changed by this PR.

Remove manual human mint/reveal/copy/reconnect, pasted approval confirmations,
plaintext/encrypted delivery envelopes, duplicated permission registries, a
bespoke login continuation and the old weak device endpoints. Retain code entry,
passkey proof, explicit scope, identity receipts and existing gates. No new
permission inheritance, standing onboarding daemon or token-copying fallback.

All errors retain safe `what_happened`, `who_acts` and a concrete next step:

| Refusal/state | Actor and recovery |
|---|---|
| Unauthenticated MCP | Owner: official Connect instructions → supported recipe → fresh consent. HTTP **401**, existing `WWW-Authenticate` including `resource_metadata`, and route-specific/RPC envelopes stay unchanged; no intent or redirect is created by the failed call. |
| Secure moments off/misconfigured | Us: configure/authorize the dedicated secure service; owner gets official support route and non-secret correlation ID, not an instruction to use /device. |
| Waiting | Owner: code entry and passkey on the secure link before displayed approval deadline; runtime polls at returned interval. |
| Wrong human/code | Intended owner: switch to locked account through safe return, or re-enter original runtime code; neither changes intent or consumes approval. |
| Missing creation/issuance authority | Owner: existing pot-setup path or named workspace-admin handoff. Never advise self-grant, sudo or agent mint. |
| Denied/expired | Runtime: stop polling. Denied requires an owner-agreed new request, expired a fresh request; no automatic retries of consent. |
| Collection refused/lost response | Runtime: revoke-only cancel the exact issuance if uncertain; owner uses authenticated recovery. Do not copy secrets or silently replay/mint. |
| Restricted authority changed/revoked | Owner: Connections → inspect/revoke; existing gated upgrade/reissue if needed. No inherited elevated access. |
| Retired /device | Owner/runtime: use official fresh-consent setup; no legacy approve/redeem fallback. |
| Unsupported store / 429 / service unavailable | Owner/runtime/us respectively: named tested recipe, bounded Retry-After, or support with correlation ID; no endless polling or weaker door. |

Deliberate departure from a direct-consent 401 link: keep the constant **public
help link**, never a request-specific approval capability or public existing-agent
lookup. That help page must identify the validated dedicated secure-host path
and explain starting a fresh request. The current hardcoded Mumega help URL is
not authoritative for forks: deployment-owned static help configuration must
point to its own trusted instructions, validated before enablement, never
copied from a request Host header or tenant-controlled content. This is copy/
configuration work, not a change to the OAuth challenge or authentication bar.

## Smallest first implementation and proof before activation

One slice: new identity in one fixed tenant/home, one authorized human, code
entry + dedicated-host UV passkey, mint-at-collection to one tested CLI's private
store, mandatory audit/provenance, restricted authority enforcement, existing
login return and /device retirement. No existing-agent public reconnect, extra
squad grants, rotation, refresh, harness-wide admission or Telegram decision.

Two independent reviewers must gate this document at its new exact head before
any build. Build acceptance requires migration-chain D1/router tests, with
mutation witnesses for each new guard, covering:

- Request naming kasra/athena/unknown produces no lookup, existing identity,
  credential or differing existence response; collision never adopts an identity.
- Shared fresh mint never creates `gate:<slug>`; gate INSERT restoration mutant
  fails. Commit and collection refuse any extra/inherited grant, gate, surface
  cap or delegation. Existing legacy mint semantics are not silently changed.
- Every identity-keyed path above rejects the restricted class, including later
  grant additions, self-completion, `human_origin`, sudo, delegation, refresh,
  token exchange and attachment laundering. Ordinary member task work still works.
- Human loss of admin/access, suspension, inactive/paused agent, consent/generation
  revoke, deadline and unavailable DB fail closed at collection AND on use; test
  both MCP and REST/actions/stream paths, including concurrent mutation races.
- Approve/deny/cancel races, duplicate collection, rollback/audit-write failure
  and lost-response uncertainty yield at most one identity/token/audit chain.
  No raw key or envelope exists at rest. `agent_token_issuance_audit` failure
  prevents issuance; no collection after a terminal transition.
- Wrong host/RP/member/session, tenant DB substitution, GET lock/approve,
  org-admin bypass, attached/sudo/elevation/Telegram/human_origin decision and
  passkey enrollment from the link are rejected. Flag off stays refused.
- Legacy /device cannot create/decide/redeem, including pre-cutover handles;
  legacy state/issuance inventory and disposition has a durable receipt.
- Per-source/public abuse cannot exhaust the reserved authenticated budget;
  compare known/unknown agent input, sign-in return/multi-tab/account switching,
  late approval with a full collection window, expiry and renewal behavior.
- Before/after HTTP contracts preserve 401 and exact OAuth challenges, including
  rich refusals, without leaking identity or allocating an intent.

Then record the timed unassisted cold walk: instructions → setup/login/code →
one human decision → private collection → authenticated UUID → first task.
Keep redacted correlated decision, issuance, connection and task receipts. Hadi's
phone walk and each promised native harness need separate proof; no inference
from CLI success. If any guard requires a second unresolved authority mechanism,
stop and cut scope for Kasra rather than waive it for the beta.

## Rollback

This documentation revision has no runtime effect. For a future rollout use a
default-off server-controlled generation gate. Activation needs an approved
artifact that includes /device retirement and all enforcement, then authorized
canary/flip; this document authorizes none of those actions.

Rollback stops new intents, invalidates pending/approved records from that
generation and refuses its collection/authentication immediately. Revoke its
issued token IDs, retain audit and identity records, release unused reservations.
The only capability rows created are new identity home-member rows; no prior
agent or grant was modified, so there is **no prior-grant restoration**. Such
fresh identities remain inert through generation/consent enforcement until an
owner makes a separately governed disposition. No new sweeper is required to
revoke uncollected keys, because none exist before collection.

Keep the retired /device door closed on rollback, even if that means disabling
all new consent. Never revert to an old artifact that restores it or discards
the restricted-token guard; first revoke generation tokens and use an artifact
that retains retirement and fail-closed enforcement. Existing independently
issued OAuth, keys and admissions keep their existing rules. No owner credential
fallback, identity deletion, restoration of gate power or automatic re-enable.

## Round-1 disposition and remaining evidence

Both receipts are in the Mumega repo under `agents/kasra/receipts/`:
`gate-pr2373-lensA-20261108.md` and `gate-pr2373-lensB-20261108.md`.

| Review class | Revision disposition |
|---|---|
| P0: existing identity capture; fictional standalone ceiling | Fresh-only public flow; exact new-member shape; explicit mint suppression and provenance/use-time/identity-path enforcement prerequisites. |
| P1: weaker /device remains | Retire all legacy decision/collection endpoints in the same rollout, even on secure-feature off/rollback; account for old raw material/issuance. |
| P1: origin, human identity and viewer freeze | Dedicated secure host only, flag off refuses, exact UV-human/locked-session equality, explicit authenticated setup POST, no role/agent approval bypass. |
| P1: late revocation and secret-at-rest custody | Eligibility inside collection transaction and every use; mint only at collection, no stored envelope or envelope key. |
| P2: enumeration, global quota, deny, late window, fatigue | No existing-agent lookup; reserved authenticated quota; passkey-only locked-human Deny; independent five-minute collection window; standard bounded revocable TTL and owner-started renewal. |
| P2: source names, receipt, return, rollback, tenant | Correct `decideAdmissionDirect`; required `agent_token_issuance_audit`; `safeReturnPath`; no restoration of prior grants; fixed tenant. |

The new guard/mint mode, safe cross-host navigation, legacy retirement and cold
walks are **UNPROVEN**: checked pinned source and both gate receipts; missing
implementation/runtime evidence; exact resolving evidence is the tests and
correlated authorized walks above. Round 2 decides whether this design is
sufficient to plan a build. No second push, scope expansion or product change
is assumed if it blocks again.
