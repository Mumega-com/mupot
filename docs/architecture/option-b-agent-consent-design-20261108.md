# Option B: owner consent, agent-owned credential

Status: **DRAFT DESIGN ONLY. Not approved for implementation.**

Author: Athena, authenticated Mupot agent `a9423609-e3bf-4797-8af8-4b9b7aecdf16`,
working through Codex on Orca following Hadi's 2026-11-08 move from Pi.
Assignment: Kasra seq **9566**, delivery `8048e981-124e-49c2-a825-d808d614e4b1`,
correlation **beta-b-design-20261108**, blocker **7e0cb92d**.

Decision supplied by the assignment: Hadi selected **Option B**, a consent page
and agent-welded grant. This document proposes its mechanics; those mechanics
are not separately approved. Order: **drafts → two independent lenses → builds
→ signs → flips**. Kasra owns Mupot core. Athena does not gate her own design.
No product code, schema, configuration, credential, merge or deployment changes
are included in this PR.

## Goal and boundary

A stranger's agent starts from the public connection instructions, gives its
owner one consent link, and receives its own credential directly after the
owner's explicit decision. The owner never copies a secret or lends their
login. The first authority decision is a single passkey-backed confirmation
from web or a Telegram entry point into the same approval. Signing in and
enrolling a first passkey are prerequisites, not invisible extra approvals.
Measure those steps in the cold walk; do not advertise a literal one-gesture
cold signup until demonstrated.

The acceptance source is `agents/kasra/docs/beta-onboarding-proud-bar-20261107.md`
in the Mumega repo, read from its active checkout on 2026-11-08. Items 3–5 require
every refusal to explain what happened, who acts and the exact next step; an
agent-owned key without copying secrets; and a one-tap decision attributable to
the owner. A design PR satisfies none of the live beta acceptance claims.

## Existing seams and alternatives

Source baseline: Mupot `7689a1f22422320925dd5e0509fda4b6330da044`.
These are source observations, not production verification:

| Seam | Source and implication |
|---|---|
| Device handoff | `src/auth/device-routes.ts`, `src/auth/device-grant.ts`: public `/device/code`, private `device_code` polling at `/device/token`, human code entry and decision. Pending TTL 600 seconds, issued token TTL 3600 seconds, poll interval 5 seconds. It starts with an existing active agent. |
| Agent credential | `src/members/service.ts`: `mintAgentBoundToken` and guarded identity-weld statements create a separate agent member/token. Reuse their invariants, not the owner's member token. |
| Provisioning and receipts | `src/members/agent-connection.ts` already models existing/new targets, explicit home access, credential actions and issuance/verification receipts. Compose with that service rather than invent a second provisioner or completion ledger. `src/mcp/provision.ts` applies `structuralGate` before minting. |
| Owner proof | `src/secure-moments/routes.ts`: passkey verifies the human and a challenge binds the decision. A bearer approval link cannot enrol a passkey. |
| Admission scope | `src/members/seat-attach.ts`: chat-bound admissions and explicit harness-scoped admissions; `decideAdmission` refuses another human's proof and refuses Full for harness scope. SQL binds harness admission to its OAuth grant. |
| Credential class | `src/members/harness-credential.ts`: unbound harness credentials have a narrow tool allowlist and zero ambient authority. Keep this class separate from agent credentials. |
| Refusal boundary | `src/auth/unauthenticated-guidance.ts`: presentation-only guidance preserves existing 401 responses and challenges. |
| Lost destination | `/device` redirects a signed-out visitor to `/auth/login`; repair the round trip with an opaque continuation, not a supplied redirect URL. Checklist #8 references card `a97a2efb`; its full task record was inaccessible by short ID, so no further card details are assumed. |

Three mechanisms considered: keep manual admin mint-and-copy (fails item 4);
make owner OAuth standing available to the agent (violates identity and access
boundaries); or extend the existing consent/device handoff with exact agent
binding and private delivery. The last implements the selected Option B.
This is not a second OAuth server or a replacement permission system.

The existing device implementation uses separate KV reads/writes/deletes for
decision and redemption. Those operations are not evidence of an atomic
single-use guarantee. Do not expose a prefilled one-tap variant by merely
changing its page. The new variant requires a serialized durable decision and
redemption transition, composed with the existing mint authorization rules.

## End-to-end flow

1. **Agent starts.** Public instructions distinguish a new agent from reconnecting
   an existing one. A request creates only an expiring, zero-authority intent.
   It returns a public consent link, a comparison code, expiry, five-second poll
   interval and a separate 256-bit redemption secret to the initiating runtime.
   The runtime stores that secret privately; it never sends it to the owner.
   Rate limits and pending caps apply before allocating durable records. Public
   start/lookup responses must not enumerate private agents or owners.
2. **Owner opens.** The official pot origin resolves the opaque intent. Link GETs,
   previews, Telegram unfurls and redirects grant nothing. A signed-out owner
   signs in and returns to this exact intent (see continuation below).
3. **Resolve the recipient before confirmation.** For an existing agent, the
   server resolves its immutable ID and eligible owner from current records;
   request-supplied names, owner IDs and email addresses prove nothing. For a
   truly new agent, the authenticated owner selects their authorized pot/home
   context; the server reserves a fresh identity there, displays it and freezes
   the resulting intent digest. It may not claim an existing sovereign identity
   by choosing its name. No capability, credential or active agent is created
   merely by starting a public request. Owners with several possible contexts
   must select one explicitly; that setup is not another authority approval.
4. **Owner sees the decision.** Display pot, signed-in account, new/existing agent
   and stable identifier, requesting app/connection, chat versus harness scope,
   requested access, credential lifetime and comparison code. Unverified app or
   runtime labels are marked as supplied by the requester. Ask the owner to
   compare with the code in the agent's original conversation and approve only
   a request they initiated. No code typing or secret copying in the happy path.
5. **One authority decision.** The owner taps Approve with passkey (or Deny).
   User-verified proof binds the immutable intent digest, human, agent, pot,
   scope, ceiling and expiry. Recheck all eligibility at commit time. Permission
   to attach a chat is not permission to mint a workspace bearer; require the
   existing credential-issuance authorization and presence/secure-moment rules
   for any bearer issuance. If that bar is unmet, refuse with recovery; do not
   call an internal mint helper to bypass it.
6. **Atomic commit.** A conditional durable transaction advances pending to
   approved and commits the exact agent identity weld, bounded grant, token hash
   and owner decision receipt, or none of them. A new-agent reservation becomes
   an active identity only in this authorized transaction. Competing approvals,
   changed scope, revocation or timeout cannot create a second credential. Deny
   is terminal and creates no credential. Receipts are required writes; optional
   notifications cannot stand in for them.
7. **Agent receives.** The initiating runtime polls using its private secret over
   TLS. Only that recipient may redeem. A serialized approved→consumed transition
   delivers the credential once, directly to protected runtime storage; neither
   the browser page, Telegram, agent prose nor the audit trail gets its value.
   The system keeps a recoverable encrypted delivery envelope only until this
   bounded redemption expires; the raw credential is not stored as plaintext KV.
   If the response is lost after consumption, revoke that issuance and restart
   consent; never replay the bearer or silently mint a replacement.
8. **Prove the result.** The runtime reconnects with the issued credential and
   calls `boot_context`, `orient`, then one authorized first task. Verify the
   returned agent UUID and effective scope against the consent receipt. Show
   separate states for approved, credential delivered, authenticated, and first
   task completed. A link click or successful poll is not task completion.

Native OAuth clients keep their supported authorization-code/PKCE transport and
exact registered redirect checks. They should deliver the agent credential
through their existing credential store rather than paste a bearer into a chat.
Do not require a chat model to retain a redemption secret in conversation text.
An app with no verified private credential-delivery mechanism is unsupported for
this slice, with a precise setup route; do not claim every harness works from a
CLI demonstration. Attached chats may continue using server-held agent tokens;
the tool-visible identity receipt must distinguish attachment from a standalone
agent bearer. An unbound harness token is never relabelled as an agent token.

## Intent, link and lifetime contract

The URL contains only a versioned route and cryptographically random opaque
intent handle on the pinned HTTPS pot/approval origin. No owner ID, bearer,
device redemption secret, email, scope JSON, authority assertion or arbitrary
callback destination is carried in it. Store a hash of the handle. Treat link
contents as potentially leaked; possession is neither approval nor redemption.

The server record binds: tenant; intent ID/version; immutable existing agent ID
or fresh reservation ID; resolved approving human; authenticated requester
identity when available; credential delivery recipient/secret hash; verified
OAuth client/grant and harness/seat identifiers when applicable; requested
connection scope and capability ceiling; fixed creation/expiry times; status;
decision-proof reference; minted token ID; delivery state; and provenance for
each material grant. Freeze and hash these before issuing the passkey challenge.
An unauthenticated runtime has no trusted identity until the owner approves this
specific recipient; a comparison code does not authenticate a vendor or machine.

Proposed defaults for Kasra's gate, matching the existing device time budget:

| Object | Lifetime / terminal behavior |
|---|---|
| Intent and consent link | 10 minutes from creation, absolute server deadline. Login, refresh or forwarding never extends it. |
| Sign-in continuation | At most the remaining intent lifetime; single-use after a validated login; no credential inside. |
| Passkey challenge | Existing secure-moment maximum, capped by remaining intent lifetime; one decision only. |
| Approved delivery envelope | Until original intent deadline, at most 10 minutes; consumed once. On expiry revoke an undelivered token. |
| First-slice bearer | At most 1 hour from issuance, revocable independently. No silent refresh or extra grant. |
| Decision/audit receipt | Retained under existing audit policy after secret deletion; contains no redeemable material. |

Expiry is enforced on every transition independently of storage TTL cleanup.
No request survives by polling. Denied, expired, cancelled and consumed intents
cannot be reopened; a replacement has a new ID and requires fresh consent.

### Approver resolution and identity reservation

An existing assigned/background agent uses its recorded owner/designated
approver policy (`memberMayConsentToBackgroundAgent`), together with the live
admin and issuance checks. Legacy agents have no unique owner in the ordinary
consent policy: `memberMayConsentToAgent` checks admin on the home squad. For
those, the first authenticated eligible human to prepare the consent view is
atomically frozen as this intent's approver; the page says they are approving
as a workspace administrator, not a uniquely registered owner. Once frozen,
another admin cannot take over that intent. Public link opening cannot freeze
an approver. Authority transfer or access loss invalidates the pending intent;
it does not silently retarget it. A newly eligible human starts a fresh request.

For a new identity, the authenticated human must pass the existing connection
service's creation **and admin credential-issuance** checks in the selected home
squad. A stranger without that authority receives the explicit workspace-admin
handoff; this design does not grant them a pot or self-assigned admin rights.
Fresh-customer pot creation remains the existing separately authorized onboarding
path. The owner chooses/accepts an available slug and untrusted display name;
the server allocates a fresh UUID. Use an expiring reservation keyed to this
intent and tenant/home context, with bounded quotas. A collision returns
`slug_taken` and asks the owner to choose another name, never reuse the occupant.
Changing the reserved identity invalidates any issued challenge. Expiry releases
only that reservation; it cannot delete a live agent. This is proposed reservation
behavior atop the existing provisioner, not a claim that reservations exist today.

## How authority stays with the agent

The human is `approved_by`, never the token's principal. The issued token's
`agent_id` is the exact approved agent UUID and its `member_id` is that agent's
active identity binding. It has its own token ID/hash, expiry and revocation
path. It does not copy the owner's login/session, owner role, unrelated grants
or an operator credential. A public request never creates standing by itself.
Use the existing connection receipt for issuance and verification, linked to
the new owner-decision/intent record. Do not equate its `credential_issued`
state with `client_connected` or `messaging_verified`.

First slice: one explicit home context, member ceiling, no org/department-wide
grant, gate, delegation, deploy or credential-mint power. Effective authority is
the intersection of the approved ceiling, agent's current grants and the
approver's current eligible authority, checked on use; the saved consent is not
a snapshot of permanent owner power. If existing workspace-token machinery
does not enforce that live ceiling and consent provenance, extending that
enforcement is a prerequisite, not an assumption about `mintAgentBoundToken`.
Agent deactivation, owner suspension/access loss, consent revocation or token
expiry fails closed. Unrelated pre-existing agent grants are not overwritten.

An agent-bound bearer establishes a server-side principal, not possession of a
hardware signing key. A separate runtime signing-key enrollment remains a
different operation. Anyone who steals a bearer can use its scope: private
delivery, short expiry and revocation are necessary, not cryptographic device
attestation claims.

## Phishing, wrong approver and sign-in return

| Threat | Required defense |
|---|---|
| Forwarded/stolen consent link | GET never mutates; authenticated eligible human plus user-verified passkey must decide; link cannot redeem. Unknown account sees no private request detail. |
| Wrong signed-in account or another admin | Exact resolved approver check, not merely any tenant admin. Offer Switch account back to the same live intent; do not rebind the intent to whoever signed in. |
| Attacker initiates a request for a victim | Show comparison code and recipient details from the original request; tell human not to approve unsolicited requests. Passkeys prevent forged human proof, not social engineering of a real owner. A mismatched/unrecognized request must be denied. |
| Agent/scope/client substitution | Immutable server record and challenge digest; recheck at commit. Changing agent or scope creates a new intent and proof. Escape requester text and never render it as trusted instructions. |
| Login CSRF or open redirect | Random continuation bound to browser login state, intended tenant/origin and intent; exact allowlisted internal destination after state validation. Never accept raw `next`, protocol-relative URLs or an agent-supplied return host. |
| Link scanners, duplicate taps and poll races | No decisions on GET; CSRF/origin checks on authenticated actions plus passkey proof. Durable conditional state transitions; no KV get/delete single-use claim. |
| Code guessing or flooding | High-entropy private secret, short public code used only for comparison, attempt throttles and bounded pending allocations; no public pending list. |
| Token leakage | No-store, no third-party analytics on consent/redemption pages, restrictive referrer policy, redacted logs; no secret in URL, browser storage, Telegram callback or chat. |

Card `a97a2efb` is a dependency for the sign-in round trip: save an opaque
continuation before redirecting to login; after valid Google/email/Telegram
login, consume that continuation and reopen the same live consent view. Preserve
the existing OAuth state/cookie/PKCE and pinned callback checks. Login success
never auto-approves. Test multi-tab/account switching, other-device email links,
expired requests and reused continuations; incompatible browser binding gives
a safe restart of the original link, not a trip to Home or an open redirect.

No passkey yet: send the owner to authenticated Account enrollment with a safe
return to this intent. Never enroll from the bearer approval link. If expiry
passes during setup, explain that the agent must generate a fresh request.

Telegram is an entry surface for the same secure approval, not a new authority
source. A bot callback, chat ID or forwarded button alone cannot decide.
Use the existing verified Telegram-to-member association and secure-moment
passkey page, bound to the identical intent. Without that association, route
to sign-in on the official origin. Do not claim in-chat one-tap approval until
its human-proof and attribution path has been walked.

## Harness scope and approval per chat (#10)

Keep explicit **this chat** versus **this connected app's chats** scope. A
chat-scoped approval remains on its requesting seat; `approval_bound_to_other_chat`
must not become automatic reassignment. Existing explicit move/reapproval
behavior remains available with its own authority checks.

An owner may expressly choose harness scope in the same passkey decision.
Bind it to the exact live human + harness + OAuth installation/grant + agent,
not a vendor name, shared directory token or model label. Other chats reuse it
only through current admission/attachment checks. Preserve member/lead ceilings,
no Full and no inherited gate authority for harness scope. Revoking the install
or admission stops reuse. This is one approval for a stated scope, not blanket
permission for every future connection. Do not silently enlarge an existing
chat approval or turn an attachment into a standalone workspace credential.

## Refusals that lead somewhere (bar item 3)

Each response has safe `what_happened`, `who_acts` and a concrete next action,
with state-specific deadlines where relevant. No tenant/member enumeration in
public refusals. Proposed copy and recovery contracts:

| Situation | Who acts / exact next action |
|---|---|
| Unauthenticated MCP 401 | Owner: open the static official Connect help URL, select the supported connection recipe, start consent. Keep HTTP **401**, existing OAuth `WWW-Authenticate` challenge and resource metadata unchanged. Do not create an intent as a side effect of a failed MCP call. |
| Waiting for approval | Owner: open this consent link before the displayed expiry. Agent: poll no faster than the returned interval. |
| Wrong owner | Owner: switch to the request's eligible account using a bound return; if unavailable, cancel and ask the intended owner to initiate correctly. |
| Missing passkey | Owner: authenticated Account → register passkey → return to this request; show remaining time. |
| Other chat's approval | Agent: return to the requesting chat or ask for explicit move/new approval; explain harness scope as an owner choice. |
| Denied / expired | Agent: stop polling; denied needs a revised owner-agreed request, expired needs a fresh link. No automatic resubmission loop. |
| Lost/expired delivery | Agent: restart consent; service revokes undelivered issuance before replacement. Never ask owner to copy a token. |
| Unauthorized scope / inactive agent | Owner: use Connections to revoke/correct the request or ask the named workspace admin; no self-raise tool suggestion. |
| Unsupported credential store / service failure | Owner: use the explicitly tested recipe; service failure names us as actor with official support route and a non-secret correlation ID. No instruction to retry forever. |

Unknown or richer route-specific refusals retain their existing envelopes and
semantics. Guidance changes are presentation only; do not convert a 401 to 200,
redirect a machine challenge into HTML, or make initialization bypass auth.

## Remove before adding

Remove the manual mint/reveal/copy/reconnect sequence from this happy path,
the instruction to lend the owner's login, obligatory user-code typing where
a safe prefilled link suffices, pasted approval confirmations, repeated
approval for chats already covered by an explicit harness admission, and the
sign-in detour to Home. Automatic private polling replaces the paste-back.

Reuse Connect help, the consent/secure-moment view, Connections revocation,
the identity-weld mint service and existing connector storage. Add only missing
intent/provenance and atomic delivery state to support that flow. No parallel
agent registry, permission model, key dashboard, long-running onboarding daemon,
new member authority class or weaker provisioning endpoint. Existing manual
admin recovery remains available under its existing gate.

## Smallest first slice and gates

The first **later implementation** slice is a complete round trip for one
existing active agent, one authorized owner, one member-scoped short-lived
credential and one CLI with demonstrated private storage. It includes
sign-in return, passkey consent, atomic issuance/redemption, revocation and
actionable refusals. It is not the whole stranger-onboarding blocker: fresh
agent creation and native OAuth/Telegram/harness-wide walks remain explicit
follow-on acceptance work. This avoids adding public identity creation to the
same initial change as credential delivery.

After that seam is independently proved, add fresh identity reservations using
existing provisioning invariants, then integrate tested OAuth stores and the
existing harness-scope UI. Each increment removes the corresponding manual
step. Do not mark blocker #1 or bar items 4–5 complete after only the CLI slice.

Before any build, Kasra and a fresh independent reviewer must decide at the
exact document head: (1) the issuance chokepoint and live-ceiling enforcement;
(2) the transactional storage/encrypted delivery boundary; (3) the proposed
10-minute/1-hour budgets; (4) supported first harness and new-agent rollout;
(5) whether web/Telegram wording truthfully meets the one-decision bar.
These are implementation entry gates, not authority to merge, deploy or flip.

Required future proof (not run or claimed by this doc PR):

- Migration-chain D1 tests for concurrent double approve/redeem, expiry at each
  boundary, revocation/owner-access loss races, crash before/after commit and
  delivery, abandoned reservations and audit failure. Mutation-prove the guards.
- Adversarial tenant/agent/owner/client/scope swaps, stolen public link without
  private secret, wrong approver, unauthorized mint, inactive agent, no ambient
  owner power, absent harness proof, no Full/gate inheritance and no secret logs.
- Browser round trips for each login type, signed-out approval, multiple tabs,
  wrong account, passkey enrollment/return and Telegram forwarding/unfurling.
- Contract tests compare unauthenticated MCP status and OAuth challenge before
  and after, including `resource_metadata`; no regression from richer refusals.
- Timed cold walk with no assistance: link shown → owner decision → private
  credential receipt → authenticated UUID/scope → first task. Retain redacted,
  correlated human-decision and issuance receipts. Repeat per supported harness,
  plus Hadi's phone walk before claiming the beta bar.

## Rollback

This PR's rollback is closing/reverting a documentation-only change; it changes
no runtime behavior. A future rollout needs a default-off, server-controlled
gate on only this new consent-delivery variant, with a recorded activation
generation. That gate is a proposal, not an existing flag claim.

On rollback: stop new intents; terminate pending intents from that generation;
disable redemption and revoke undelivered and explicitly affected issued tokens
by recorded token IDs. Every issued token must also carry its consent/grant
provenance so revocation immediately removes the new authority. Do not delete
agent/member identities, unrelated pre-existing grants or historical receipts.
Where the rollout added a grant, restore its prior state only with a guarded
version/provenance match; a later legitimate owner change must survive rollback.
Leave additive schema and audit history in place. Old OAuth, existing agent
keys, chat admissions, access gates and 401 challenges continue under their
existing rules. Tell affected agents to use the gated supported connection path,
not to borrow an owner credential. Re-enable only after a fresh gate and canary.

## Standards and evidence limits

The device interaction and comparison-code defenses draw on
[RFC 8628 §§3 and 5](https://www.rfc-editor.org/rfc/rfc8628);
OAuth redirect, CSRF and credential protections are constrained by
[RFC 9700](https://www.rfc-editor.org/rfc/rfc9700). This proposed extension is not
a claim that the existing device code implements every RFC guarantee.

Read for this draft: the pinned source seams above, Kasra's exact message,
the proud bar and beta checklist, and active Athena boot/ownership/priorities
files in the original Mumega checkout (the Orca site snapshot lacked the latter
three). Mupot authenticated Athena and orient returned task context. SOS boot
was inaccessible: local Athena configuration had no usable Authorization
binding. No runtime, rollout, native harness delivery or two-lens acceptance
is proven. The exact evidence to resolve those gaps is the gated implementation
and correlated tests/walks listed above; no access control may be relaxed to
make a walk pass.
