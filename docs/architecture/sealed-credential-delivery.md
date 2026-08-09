# Sealed credential delivery

**Status:** DESIGN — not implemented, not scheduled. Ships in a later deploy, deliberately
not the currently blocked batch.
**Author:** Athena, 2026-08-09
**Branch:** `wt/sealed-cred-design`
**Scope:** how an agent obtains an agent-bound bearer token without the raw secret passing
through the minting operator's context.

This document changes no code. Every claim about current behaviour is cited `file:line`
and was re-verified against `origin/main` @ `96bdb73` in a clean worktree.

---

## 1. Problem statement (re-verified)

### 1.1 The premise holds. There is no non-leaking mint path.

I checked for one specifically, including the possibility that the signed-runtime work had
already shipped a bearer-free route. It has not — for *minting*. Details in §2.

Three mint surfaces exist. All three either hand the raw secret to a programmatic caller or
require a human browser.

**(a) `mint_agent_token` (MCP) returns the raw token to the caller.**

The tool is declared at `src/mcp/provision.ts:425-507`. Its success payload includes the
plaintext as a bare field:

```
src/mcp/provision.ts:494          raw: minted.raw,
src/mcp/provision.ts:504    note: 'raw token is shown ONCE — store it now; it is never retrievable again',
```

The security comment above it (`src/mcp/provision.ts:478-481`) is explicit that `raw` is
deliberately returned bare rather than woven into a config snippet — the concern addressed
there is *snippet reuse*, not *caller-context exposure*. The two are different threats and
only the first is currently handled.

Consequence, observed today: an operator agent that mints for a seat writes the plaintext
bearer into its own session transcript, which for a Claude Code harness is a JSONL file on
local disk. This is a real current exposure, not a hypothetical one. The token is
`sha256`-hashed at rest in `member_tokens` (`src/members/service.ts:211`, `:235-237`), so
the *database* discipline is sound; the leak is entirely in the delivery channel.

**(b) `provision_agent_connection` (MCP) leaks the same way.**

This is the higher-level composed workflow (`src/mcp/provision.ts:671-812`), and it is easy
to assume it is the "safe" path because it wraps everything in a receipt transaction. It is
not safer with respect to this problem. It returns the outcome verbatim at
`src/mcp/provision.ts:810` (`return done(outcome)`), and the outcome carries the plaintext:

```
src/members/agent-connection.ts:711      raw: token.raw,
```

Worth stating plainly because it is the natural next thing an operator reaches for: **there
are two leaking MCP mint paths, not one.**

**(c) The dashboard route does not leak to a programmatic caller — and is unreachable by one.**

`POST /admin/agent-token/mint` is at `src/dashboard/index.ts:1731`. It renders the raw token
once into HTML and never returns it as data. But the entire dashboard app is behind an
Origin-checking CSRF middleware applied app-wide:

```
src/dashboard/index.ts:228   dashboardApp.use('*', csrf())
```

There is no bearer path onto this router. A programmatic caller gets 403. That is a correct
posture for a session-cookie surface — it is simply not a credential-delivery mechanism for
anything that is not a human in a browser.

### 1.2 Agents are deliberately forbidden from minting. This is preserved.

```
src/mcp/provision.ts:437    if (auth.boundAgentId) return fail(403, 'operator_principal_required')
```

The same guard appears at `:534` (`list_agent_tokens`), `:589` (`revoke_agent_token`),
`:711` (`provision_agent_connection`), and `:833` (`grant_agent_capability`). The header comment
frames minting as "an org-trust act" (`src/mcp/provision.ts:13-18`) and is the reason mint
is gated at `admin` rather than `lead`.

**This design does not weaken that guard and does not design around it.** No proposal here
lets an agent-bound principal mint, create, or grant.

### 1.3 The escalation guard is preserved.

`mintAgentBoundToken` hard-codes the new member's grant to `scope_type='squad'`,
`scope_id=agent.squad_id`, capability `observer|member`
(`src/members/service.ts:226-229`, invariants documented at `:286-293`). The tool refuses
anything above `member` at `src/mcp/provision.ts:455-460`. A minted agent token can
therefore never inherit the operator's org-admin.

**This design does not touch the mint's capability shape.** A credential delivered through
the mechanism below is byte-for-byte the same credential with the same ceiling.

### 1.4 Downstream cost

Without an agent-bound token, `connect{}` returns a session-local claim:

```
src/mcp/index.ts:2990   // SESSION-LOCAL binding note: this does not write member_tokens.agent_id.
src/mcp/index.ts:2993   binding: 'session_local',
```

`session_local` does not set `auth.boundAgentId`, and the messaging tools require it:

```
src/mcp/index.ts:2164   if (!fromAgent) return fail(403, 'not_agent_bound', 'send requires an agent-bound token …')
src/mcp/index.ts:2242   … 'broadcast requires an agent-bound token …'
src/mcp/index.ts:2342   … 'inbox requires an agent-bound token …'
```

The HTTP mirrors fail identically (`src/agents/inbox-routes.ts:60`, `:106`). So a
session-local seat can orient and read, but cannot participate in the bus.

**One correction to the brief, made in the interest of not fixing the wrong thing.**
`flight_list` does *not* require agent binding. Its gate is `observer` on the named squad
plus workspace-admin bypass (`src/mcp/index.ts`, `flight_list.run`: `memberCanOnSquad(env,
grants, squad.id, 'observer')`). If Loom cannot call `flight_list`, the cause is a
*capability or channel* problem, not a *binding* problem — most likely the directory-channel
zero-capability rule:

```
src/mcp/index.ts:166    if (!knownNonDirectory) auth.boundAgentId = null
src/mcp/index.ts:2930   reason: 'directory_channel_zero_capability',
```

That refusal's own remediation text tells the caller to obtain a workspace-channel token via
`mint_agent_token` (`src/mcp/index.ts:2942`). So sealed delivery helps Loom *only* insofar as
Loom lacks a workspace token at all. It will not help if Loom has one and simply lacks
`observer` on the squad. Worth confirming which before counting `flight_list` as a win.

---

## 2. What already exists — the signed-identity substrate

This is the most important section, because roughly two-thirds of the machinery a sealed
delivery design would need is already built, reviewed, and in production. Anything proposed
here should extend it, not run parallel to it.

### 2.1 Per-agent Ed25519 public keys

Migration `0041` creates `agent_keys` (`tenant`, `agent_id`, `pubkey` = base64url JWK `x`,
`algo`, `member_id`, `created_at`) and `agent_attach_nonces`. Its header states the intent
directly: *"mupot stores ONLY the PUBLIC key and verifies. No bearer secret is transported
or placed."*

`member_id` is the identity binding — the mupot member the key authenticates *as*. Keys with
`member_id IS NULL`, or whose member is not `active`, are rejected by every signed endpoint
(`src/fleet/agent-keys.ts:67-77`).

### 2.2 A signed, replay-proof request protocol

`src/fleet/signed-attach.ts` implements a domain-separated, tenant-bound, time-boxed,
single-use signature check:

- canonical message with fixed field order and a domain tag first (`:48-59`)
- freshness window `±300s` (`:167-170`, window from `src/fleet/shared-nonce-ledger.ts:3-7`)
- key lookup keyed by `(tenant, agent_id)` so a signature for tenant A cannot replay against B
- nonce burned **only after** the signature verifies (`:209-218`), so unsigned junk cannot
  fill the ledger
- ledger retention deliberately `2×window` (`:203-208`) because `ts` may be future-dated

Verification uses WebCrypto only: `crypto.subtle.importKey('jwk', …{crv:'Ed25519'})` and
`crypto.subtle.verify` (`src/fleet/signed-attach.ts:78-90`, `:191`).

The nonce ledger is shared and domain-registered
(`src/fleet/shared-nonce-ledger.ts:3-23`) — adding a new signed protocol means adding one
entry to `SHARED_NONCE_WINDOWS_SEC` and passing a new domain tag. `assertSharedNonceDomainWindow`
(`:18-23`) makes a mismatched window a throw, not a silent weakening.

### 2.3 Two bearer-free routes already ship

- `POST /api/fleet/attach-signed` — `src/fleet/attach-routes.ts:249-280`. No bearer at all;
  the signature *is* the auth (`:250`).
- `POST /api/inbox/signed` — `src/agents/inbox-routes.ts:87-100`, verified by
  `src/fleet/signed-inbox.ts:89`, reading through
  `readVerifiedSignedAgentInbox` (`src/agents/messages.ts:476-482`).

There is also an anti-downgrade rule: once an agent has a registered key, the *bearer*
attach path refuses it outright (`src/fleet/attach-routes.ts:213-215`), so a leaked bearer
cannot substitute for the stronger proof.

### 2.4 An inbox transport fence

`agent_inbox_fences` (migration `0058`) pins exactly one authoritative inbox transport per
agent: `bearer_only` (default) or `signed_only` + a 64-hex `key_fingerprint`. The predicate
lives inside the read query itself (`src/agents/messages.ts:383-392`), and a signed read with
no matching fence row fails closed as `consumer_fenced` (`:377`). Flipping the fence is
workspace-admin-only with optimistic-concurrency on `generation`
(`src/mcp/index.ts:2396`, gate at `:2406`, `active_agent_key_required` at `:2428`).

### 2.5 Symmetric encryption prior art

`src/connectors/crypto.ts` already implements HKDF-SHA256 → per-record AES-GCM-256 with a
`CONNECTOR_MASTER_KEY` Worker secret (`src/types.ts:202`), with fail-closed decrypt and an
explicit plaintext-discipline comment (`src/connectors/crypto.ts:17-22`). If a design needs
server-side encryption at rest, the pattern exists and has been reviewed.

### 2.6 The precise shape of the gap

| Capability | Bearer | Signed (Ed25519) |
|---|---|---|
| Attach / detach to fleet registry | yes | **yes** (`attach-routes.ts:249`) |
| Read own inbox | yes | **yes** (`inbox-routes.ts:87`) |
| Send / broadcast | yes (`index.ts:2164`) | **no** |
| Any MCP tool | yes | **no** — MCP transport auth is bearer-only |
| Obtain a credential | operator-only, leaks | **no path** |

So: an agent with a registered key can already *prove who it is* and *drain its inbox*
without a bearer. It cannot *speak*, and it cannot *acquire* the bearer that would let it.

The gap is not "mupot has no cryptographic identity." It is: **there is no bridge from the
existing key identity to a bearer credential, and MCP requires a bearer.**

That reframing is what makes the recommendation below cheap.

### 2.7 Prior art in the docs — what has already been decided

Two findings matter more than the rest.

**(a) The hand-placed token was already rejected once, by Hadi, and that rejection produced
the signed-attach design this proposal builds on.**

```
docs/agent-running-on-mupot.md:106-110
  "The runtime proves identity by SIGNING a tenant-bound, time-boxed, single-use message
   with a host-held private key; mupot stores only the PUBLIC key (agent_keys) and verifies.
   No bearer secret is transported or placed — Hadi rejected the hand-placed token, which
   forced the stronger public-key design."
```

This is precedent, not merely a related decision. The present problem is the same objection
one layer up: the credential is no longer hand-placed on the *host*, but it is still
hand-carried through the *operator*. Recommending the signature-redeemed ticket (§4) is
applying an existing ruling to a surface it has not yet reached.

**(b) The circular onboarding path is already a named defect.**

```
docs/superpowers/specs/2026-07-24-agent-connection-flow-design.md:48-51
  "This split produces a circular onboarding path. A valid human `workspace` token can
   connect to Mupot but cannot call agent-only tools."
```

That spec is the most developed credential-delivery design in the repo and it resolves
delivery as **show-once + paste-ready config** (`:227-231`), with an out-of-band
`verify_agent_connection { receipt_id, challenge }` callback *after* the operator installs the
config (`:534-542`). It is a good design for a human operator. It has no answer for an
operator that is itself an agent with a logged transcript — which is the case that now
dominates.

Also load-bearing, and pointing the same way as my recommendation:

- **"storing recoverable raw credentials" is an explicit Non-Goal**
  (`.../2026-07-24-agent-connection-flow-design.md:792`). Generating the token at redemption
  rather than at issuance (§4.1) is what keeps §4 on the right side of this. A sealed blob
  parked in a table would not be.
- **"requiring an Ed25519 runtime key before basic MCP messaging" is also a Non-Goal**
  (`:794`). Read strictly, that constrains §5: key-first bootstrap must remain **one available
  path, never the only one**. This is why §6 keeps `mint_agent_token` alive rather than
  deprecating it — the Non-Goal makes non-deprecation a requirement, not just caution.
- `identity-access-fix-map.md:86` scopes `agent_keys` out of the 2026-07 identity arc as
  "orthogonal: signing/transport… out of scope, adjacent". This document argues that
  boundary has outlived its usefulness: the signing plane is now the only plane with a
  non-leaking identity proof.
- `identity-access-fix-map.md:42` (S3): **there is no token TTL at all** today. Ticket TTL
  (§8.7) is not a new concept being introduced; it is the first TTL in the credential path.
- `sovereign-core-operated-presence.md:136-138` gestures at exactly this: *"v0.26: governed
  tools introduce scoped credentials without exposing raw secrets — the guest-credential
  primitive is the same governance family (precursor)."* Aspirational; never designed.

**Nothing in `docs/` proposes sealed credentials, claim tickets, one-time retrieval, or
encrypted token delivery.** Greps for `sealed credential`, `claim ticket`, `one-time
retrieval`, `HPKE`, `X25519`, `unwrap` return zero. Every "sealed" hit is a sealed *port* /
sealed authority seat (`substrate-contract.md:38`, `:53`) — sealed interface, not sealed
secret. So §4 is genuinely new, which is a reason for extra adversarial scrutiny (§8), not
for confidence.

**Current workaround worth naming:** DME punts delivery to an external secret manager — the
welded operator token is mounted from a host-only secret at
`/run/secrets/mupot-agent/token`, never in env or rendered YAML
(`docs/runtime-starter.md:224-231`). That is a good mitigation and it is also an admission:
mupot has no delivery mechanism of its own, so operators bolt one on. Anywhere without
Kubernetes secrets gets a transcript instead.

### 2.8 The bootstrap chicken-and-egg, located precisely

`register_agent_key` requires the agent's member identity to already exist:

```
src/fleet/agent-keys.ts:91-101   SELECT b.member_id FROM agent_member_bindings b JOIN members m …
src/fleet/agent-keys.ts:103      if (!identity) return { ok: false, reason: 'identity_unminted' }
src/mcp/provision.ts:935-937     → fail(409, 'agent_identity_unminted', 'call mint_agent_token before registering the key')
```

And the *only* thing that writes `agent_member_bindings` is the mint batch:

```
src/members/service.ts:222-225   INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
```

(Confirmed sole writer: `grep -rn agent_member_bindings src/` returns only reads elsewhere;
the other write is the one-time backfill in `migrations/0071_agent_connections.sql:78`.)

Therefore: **key registration requires a prior mint, and the mint is the thing that leaks.**
The cycle is `mint (leaks) → binding → key → signed identity`. Every seat that has a
registered key today got it *after* a leaking mint. This is the crux, and §5 breaks it.

---

## 3. Options

### Option A — sealed blob returned from `mint_agent_token`

The mint encrypts the raw token to the agent's public key and returns ciphertext. The
operator handles only the blob.

**Fatal-ish problem: the key we have is the wrong kind of key.**
Ed25519 is a *signature* scheme. WebCrypto cannot perform key agreement with an Ed25519 key —
there is no `deriveBits` for `Ed25519`. Sealing to that key requires one of:

- **A1.** Register a *second*, X25519 key per agent and do ECDH → HKDF → AES-GCM. This is
  WebCrypto-native (`X25519` `deriveBits` is available on the Workers runtime — *verify against
  the pinned `compatibility_date = "2026-06-01"` before building*, `wrangler.example.toml:8`).
  Cost: a second key column/table, a second registration ceremony, a second thing to rotate,
  and a second thing to get wrong. It does not reuse the existing registration flow.
- **A2.** Birationally convert Ed25519 → X25519. Not in WebCrypto. Requires `@noble/curves`,
  which would be the **first cryptographic runtime dependency in the project** — current
  runtime deps are four, none cryptographic (`package.json`: `@cloudflare/workers-oauth-provider`,
  `@modelcontextprotocol/sdk`, `cron-schedule`, `hono`). It also means reusing one keypair
  across two schemes, which is exactly the practice the domain-separation discipline in this
  codebase exists to avoid (`src/fleet/signed-attach.ts:30-32`).
- **A3.** Seal symmetrically with a server-held master key (reusing
  `src/connectors/crypto.ts`). This is *not* sealing to the agent — the server can decrypt,
  so the blob is only opaque to the *operator*. That may actually be acceptable (the server
  is already trusted with the hash and the whole DB), but it means the blob must be
  redeemable, at which point it *is* a claim ticket with extra steps.

Note also: `nodejs_compat` is enabled (`wrangler.example.toml:9`), so `node:crypto` is
technically reachable. It should still not be used — the entire signed surface is WebCrypto
and mixing would create two crypto stacks in one Worker.

**Second problem, independent of curve choice: a sealed blob has no lifetime.** It is a
static ciphertext. If it lands in a log, a git commit, or a bus message, it stays valuable
until someone remembers to revoke the underlying token. Nothing about it expires.

### Option B — one-time claim ticket, redeemed by signature

The operator mints and receives **no secret at all** — only a ticket id. The agent redeems
the ticket at a new bearer-free endpoint by signing it with the Ed25519 key it already has
registered. The response carries the raw token to the agent and to nobody else.

Crypto required: **none that isn't already written.** Redemption is `verifySignedAttach` with
a different domain tag and a different canonical message. Same key table, same nonce ledger,
same freshness window, same WebCrypto calls.

Costs, stated honestly:
- one additive table (`agent_credential_tickets`)
- one new route
- a TTL and a revoke/list surface, or tickets become dangling authority
- the token now exists server-side between mint and redemption, so it must be stored
  encrypted at rest (Option A3's mechanism, `src/connectors/crypto.ts`) or generated at
  redemption time. **Generate at redemption** — see §4.

### Option C — do nothing to mint; extend the signed surface until bearers are unnecessary

Add `POST /api/inbox/send-signed` mirroring `/api/inbox/signed`, and eventually a signed MCP
transport. Then agents never need a bearer.

This is almost certainly the correct *destination*. It is not a near-term option: MCP's auth
model is bearer-based end to end, `send` is only one of ~90 tools, and each signed mirror is
a new attack surface reviewed one at a time. It also does not solve provisioning for anything
that is not a long-lived host runtime.

Keep it as the stated north star; do not block on it.

---

## 4. Recommendation

**Option B — the one-time claim ticket — with the token generated at redemption, not at
issuance.**

### 4.1 Why

1. It reuses a reviewed, deployed crypto path instead of introducing a second one. No new
   dependency, no new curve, no `@noble/curves`, no second key per agent.
2. Generating the token at redemption means **the plaintext never exists on the server
   before the agent asks for it**, which removes the at-rest encryption question entirely.
   Nothing to seal, nothing to leak from the tickets table.
3. Tickets have a TTL and are single-use. A sealed blob has neither.
4. It leaves the escalation guard and the operator-principal rule byte-for-byte untouched:
   issuing a ticket is an operator act, gated exactly like the mint it replaces.

### 4.2 Shape

Two new operator tools and one new bearer-free route.

**`issue_credential_ticket`** (MCP, operator-principal, `admin` on the agent's squad —
identical gating to `mint_agent_token`, `src/mcp/provision.ts:437`, `:448-450`)

Returns: `{ ticket_id, agent_id, capability, expires_at }`. **No secret.** The operator can
paste this into a bus message or a transcript without consequence.

Records in a new additive table:

```sql
-- migrations/00NN_agent_credential_tickets.sql  (additive; no drops)
CREATE TABLE IF NOT EXISTS agent_credential_tickets (
  tenant           TEXT    NOT NULL,
  ticket_id        TEXT    NOT NULL,
  agent_id         TEXT    NOT NULL,
  key_fingerprint  TEXT    NOT NULL,          -- pinned at issuance; 64 hex
  capability       TEXT    NOT NULL CHECK (capability IN ('observer','member')),
  label            TEXT    NOT NULL,
  issued_by        TEXT    NOT NULL,          -- member id of the operator
  issued_at        INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  redeemed_at      INTEGER,
  redeemed_token_id TEXT,
  revoked_at       INTEGER,
  PRIMARY KEY (tenant, ticket_id)
);
```

`key_fingerprint` is pinned **at issuance** from `loadActiveAgentKey`
(`src/fleet/agent-keys.ts:67-77`) using `agentKeyFingerprint` (`:45-48`) — the same
fingerprint primitive the fence already uses. This is load-bearing; see §8.3.

**`POST /api/credential/claim`** (no bearer; the signature is the auth — same posture as
`src/fleet/attach-routes.ts:250`)

Body: `{ ticket_id, agent_id, ts, nonce, sig }`.

Canonical signed bytes, new domain tag, mirroring
`src/fleet/signed-attach.ts:48-59`:

```
credential-claim:v1 \n <tenant> \n <agent_id> \n <ticket_id> \n <ts> \n <nonce>
```

Register `'credential-claim:v1': 300` in `SHARED_NONCE_WINDOWS_SEC`
(`src/fleet/shared-nonce-ledger.ts:3-7`) so the shared ledger and the window assertion
(`:18-23`) cover it.

Verification order, all of which must pass before any write:
1. shape/field validation on the untrusted body
2. freshness `|now − ts| ≤ 300`
3. `loadActiveAgentKey(env, agent_id)` — active member binding required
4. signature verifies over the canonical bytes
5. ticket exists, matches `agent_id`, is unexpired, unredeemed, unrevoked, **and its pinned
   `key_fingerprint` equals the fingerprint of the key that just signed**
6. nonce burned (`burnSharedAgentNonce`, domain `credential-claim:v1`)
7. **only now** call the existing `mintAgentBoundToken` (`src/members/service.ts:298`) —
   unchanged, same escalation guard — and mark the ticket redeemed in the same batch

Response: the raw token, exactly once, to the redeeming runtime. Plus `mcp_endpoint` and
`wake_contract` as `mint_agent_token` already returns (`src/mcp/provision.ts:497-503`).

**`list_credential_tickets` / `revoke_credential_ticket`** — operator tools, same gate.
`mupot#682` already established the principle that an issue surface without a
see-and-withdraw counterpart is a defect (`src/mcp/provision.ts:511-520`). Do not repeat it.

### 4.3 What the operator's transcript contains afterwards

A ticket id, an agent id, a capability, and an expiry. Nothing that authenticates anything.

---

## 5. Bootstrap — breaking the cycle without weakening the guard

The cycle from §2.8 is `mint (leaks) → agent_member_bindings → agent_keys → signed
identity`. A brand-new agent has no key, so it cannot redeem a ticket.

**The fix is to observe that the mint currently does two unrelated jobs in one batch.**
`prepareAgentBoundTokenMintForBinding` (`src/members/service.ts:179-255`) writes four rows on
first mint:

1. `members` — the identity envelope (`:219-221`)
2. `agent_member_bindings` — the immutable weld (`:222-225`)
3. `capabilities` — the hard-capped home grant (`:226-229`)
4. `member_tokens` — **the credential** (`:233-238`)

Rows 1–3 are *identity*. Row 4 is *secret*. Only row 4 leaks. They are batched together for
atomicity, not because they are conceptually one act.

**Proposal: `bind_agent_identity` — a new operator tool that commits rows 1–3 and stops.**

- Operator-principal + `admin` on the agent's squad: identical gating to mint.
- Reuses the *same* hard-coded grant construction, so the escalation guard is not
  re-implemented and cannot drift. Refactor `prepareAgentBoundTokenMintForBinding` so the
  identity statements and the token statement come from one shared builder; both callers use
  it. No behavioural change to the existing mint.
- Returns `{ agent_id, member_id, capability }`. **Structurally incapable of returning a
  secret** — it never generates one.
- Idempotent: if the binding exists, return it. The `UNIQUE` constraint and the existing
  `agentIdentityConflict` handling (`src/members/service.ts:257-264`) already cover the race.

Bootstrap then becomes, for a brand-new agent:

| # | Actor | Act | Secret in transit? |
|---|---|---|---|
| 1 | operator | `create_agent` | no |
| 2 | operator | `bind_agent_identity` | no |
| 3 | host runtime | generate Ed25519 keypair locally; private key never leaves the host | no |
| 4 | operator | `register_agent_key { public_key }` | no — public material only (`src/mcp/provision.ts:956`) |
| 5 | operator | `issue_credential_ticket` | no |
| 6 | **agent** | `POST /api/credential/claim` signed with its own key | **only to the agent** |

Every operator step is unchanged in authority: still operator-principal, still `admin` on
the squad, still capped at `observer|member`. Nothing an agent can call was added. The
escalation guard is not merely preserved — it is now enforced in exactly one shared builder
instead of one inline batch.

Step 4 is where the public key crosses from the host to mupot. It is *public* material, so
transport exposure is not a secrecy problem — but it **is** an authenticity problem, and it
is the load-bearing trust act in the whole chain. See §8.1 and §8.3.

---

## 6. Backward compatibility

**Nothing breaks. Nothing is removed. All migrations are additive (one `CREATE TABLE IF NOT
EXISTS`); no drops, no column changes, no trigger changes.**

| Surface | After this change |
|---|---|
| Existing agent-bound tokens | unaffected — no change to `member_tokens` or its resolution |
| `mint_agent_token` | **stays, unchanged, still returns `raw`** |
| `provision_agent_connection` | stays, unchanged |
| Dashboard `POST /admin/agent-token/mint` | stays, unchanged |
| Existing `agent_keys` rows | unaffected; become redeemable identities for free |
| `agent_inbox_fences` | untouched; default `bearer_only` preserved (`src/agents/messages.ts:383-386`) |
| Bearer `/api/fleet/attach` downgrade block | untouched (`src/fleet/attach-routes.ts:213-215`) |
| Signed attach / signed inbox | untouched; only a new domain tag is added to the shared ledger |

**Deliberate: `mint_agent_token` is not deprecated in this change.** Removing the only
working path while introducing an unexercised one is how you strand a fleet. Deprecation is
a separate decision after the ticket path has real production mileage (§9, phase 5) and is
an open question for Hadi (§10).

**Seats currently on `session_local`:** they are unaffected and, importantly, **not
auto-fixed**. `session_local` is not a broken state that this design repairs; it is the
correct output of `connect{}` for a token with no weld (`src/mcp/index.ts:2990-2994`). Those
seats still need an operator to provision them. What changes is only that the provisioning
no longer deposits their bearer in the operator's transcript. Any seat that already has an
`agent_keys` row can be moved to the new path immediately — the operator issues a ticket and
the seat redeems it. Any seat that does not needs steps 2–4 of §5 first.

---

## 7. What this does NOT fix

Stated explicitly, because the temptation to over-claim here is real.

1. **Agents still cannot mint.** `operator_principal_required` is untouched. An agent cannot
   issue itself a ticket, cannot register its own key, cannot bind its own identity.
2. **The human is not removed from provisioning.** Five of the six bootstrap steps are
   operator acts. An operator with `admin` on the squad must still: create the agent, bind
   its identity, register its key, and issue the ticket. This design changes *what the
   operator handles* (an id instead of a secret), not *whether an operator is needed*.
3. **It does not remove the raw token from the agent's own process.** The redeeming runtime
   receives plaintext and must store it. If that runtime logs its HTTP responses, the secret
   is in a log — just a different log. The win is precisely and only: *the secret no longer
   passes through a party that has no use for it.* That is a real and worthwhile reduction in
   blast radius; it is not end-to-end secrecy.
4. **It does not retroactively clean any transcript.** Every token minted through the current
   path — including the kasra-seat token minted today — is exposed and should be treated as
   such. Those need `revoke_agent_token` (`src/mcp/provision.ts:577`) and re-issuance,
   independent of this work.
5. **It does not fix `flight_list` for Loom** unless Loom's blocker is genuinely the absence
   of a workspace token (§1.4). Check before claiming.
6. **It does not let agents `send` without a bearer.** That is Option C and remains unbuilt.
7. **It does not address key rotation.** `registerAgentPublicKey` explicitly refuses implicit
   rotation (`src/fleet/agent-keys.ts:79-83`, `:108-114`, `key_conflict`). A rotation ceremony
   is out of scope and is an open question (§10).

---

## 8. Adversarial review — arguing against my own design

Run as a first-class section, not an appendix, per the adversarial-as-parallel-gate rule. The
findings below are against *this design* and against *current code*; the current-code ones do
not wait for this design to ship.

### 8.1 BLOCK — `register_agent_key` is missing the operator-principal check

This is the most serious thing I found, and it is **live today**, independent of this design.

Every sibling provision tool refuses agent-bound callers:

```
src/mcp/provision.ts:437   mint_agent_token             → operator_principal_required
src/mcp/provision.ts:534   list_agent_tokens            → operator_principal_required
src/mcp/provision.ts:589   revoke_agent_token           → operator_principal_required
src/mcp/provision.ts:711   provision_agent_connection   → operator_principal_required
src/mcp/provision.ts:833   grant_agent_capability       → operator_principal_required
```

`register_agent_key` does not:

```
src/mcp/provision.ts:908   async run(auth, env, args) {
src/mcp/provision.ts:909     const agentRef = str(args.agent)      ← no boundAgentId check
src/mcp/provision.ts:917     if (!(await memberCanOnSquad(env, grants, agent.squad_id, 'admin')))
```

The test that enumerates this invariant covers `mint_agent_token`,
`grant_agent_capability`, and `provision_agent_connection`
(`tests/provision-tools.test.ts:291-315`). `register_agent_key` is **not in the list**.

Until recently this was probably unreachable: no bound agent could hold `admin`, so the
`admin` gate at `:917` was itself an implicit operator check. That changed this week.

```
migrations/0087_drop_home_capability_ceiling.sql:1-20
  "Hadi directive 2026-08-09: remove the home_capability_ceiling rule.
   Net effect: no bound agent can ever hold admin … This migration drops the five
   triggers that enforce the ceiling."
```

And `admin` is grantable to an agent through a normal operator act:

```
src/mcp/provision.ts:80    GRANTABLE_AGENT_CAPABILITIES = new Set(['observer','member','lead','admin'])
tests/provision-tools.test.ts:284   capability: { type: 'string', enum: ['observer','member','lead','admin'] }
```

**Therefore:** an agent-bound token holding `admin` on squad S can call `register_agent_key`
for **any agent on squad S**, including peers it does not control.

Consequences *today*, before any of this design ships:

- **Peer denial-of-service.** Registering a key for peer P immediately closes P's bearer
  attach path — `hasRegisteredKey` makes `/api/fleet/attach` return 403
  (`src/fleet/attach-routes.ts:213-215`). P cannot report itself running.
- **Peer inbox capture, conditional.** With a key registered for P, an operator flipping P's
  fence to `signed_only` would pin `key_fingerprint` to the attacker's key
  (`src/mcp/index.ts:2427-2430`), after which the attacker drains P's inbox via
  `POST /api/inbox/signed` and P's bearer reads return nothing
  (`src/agents/messages.ts:383-392`). Requires an operator to flip the fence, so it is a
  confused-deputy path, not a direct one. Still bad.
- The 409 `key_conflict` on differing keys (`src/fleet/agent-keys.ts:108-114`) limits this to
  agents with **no** key yet — i.e. exactly the new seats this design is about.

**Consequences under this design:** registering a key for peer P lets the attacker redeem
**P's credential ticket** and obtain P's bearer. That converts a nuisance into full identity
theft of a peer. Note this is *not* privilege escalation past the guard — P's token is still
capped at `observer|member` on P's own squad — but it is impersonation, and the audit trail
would attribute P's actions to P.

**Required mitigation, and it must land BEFORE §4/§5, not with it:**

- add `if (auth.boundAgentId) return fail(403, 'operator_principal_required')` at
  `src/mcp/provision.ts:908`
- add `register_agent_key` to the enumerated list in `tests/provision-tools.test.ts:291`
- **mutation-check that test** — flip the guard off and confirm the test actually fails.
  A regression test that passes with the bug reintroduced is decoration.
- decide whether this is a breaking change for any agent currently relying on it (open
  question §10.1)

I am flagging this as a gate-blocking finding on the *current* codebase. It is small, and it
is a prerequisite: **a ticket redeemable by a signature is only as trustworthy as the
registration of the key that signs it.** Building §4 on top of an unguarded `register_agent_key`
would be building the vault door onto a frame anyone with squad-admin can re-hang.

### 8.2 Is the sealed blob replayable? (arguing for Option A's rejection)

Yes, in the sense that matters. A sealed blob is a static ciphertext with no expiry and no
single-use property. If it is captured before the agent decrypts it, it stays valuable until
the underlying token is manually revoked — and nobody revokes a token they don't know leaked.
The claim ticket's TTL + single-use + nonce burn is not incidental; it is the reason to
prefer it. Option A could bolt on a TTL, but a TTL on a blob you already handed out is a
promise, whereas a TTL on a server-side row is an enforcement.

### 8.3 Can the ticket be redeemed by the wrong party?

Only by whoever holds the private key matching the fingerprint pinned at issuance. So the
question reduces entirely to §8.1 and to whether key registration is honest. Two additional
hardenings, both cheap:

- **Pin the fingerprint at issuance, not at redemption.** If the ticket only named
  `agent_id` and redemption looked up "whatever key is registered now," then a key registered
  or rotated *between* issuance and redemption would silently retarget the ticket. Pinning
  makes that a mismatch → refusal. This is why `key_fingerprint` is `NOT NULL` in §4.2.
- **Refuse issuance when no active key exists.** Mirror
  `active_agent_key_required` (`src/mcp/index.ts:2428`) — do not allow a ticket to sit around
  waiting for a key to appear, because "waiting for a key to appear" is precisely the
  attacker's window.

Residual risk: a host that leaks its private key. That is out of scope for mupot and true of
the existing signed-attach surface too.

### 8.4 Does the key-registration path become a new escalation surface?

It already is one (§8.1). This design *increases the value* of that surface, which is exactly
why the fix is a prerequisite rather than a follow-up. Beyond §8.1:

- `bind_agent_identity` must never be callable by an agent, for the same reason. It creates
  the `agent_member_bindings` row that `register_agent_key` requires; an agent that could
  call both would own the entire chain up to the ticket.
- The binding is immutable by trigger
  (`migrations/0071_agent_connections.sql:108-112`, `agent_member_bindings_no_update`), which
  is a real protection — a wrong binding cannot be silently corrected, only deleted, and
  deletion is itself gated (`:134`, `agent_member_bindings_delete_requires_no_tokens`).
  Worth noting that `bind_agent_identity` therefore makes an **irreversible** write, and its
  confirmation UX should say so.

### 8.5 Shared nonce ledger — cross-domain collision

`agent_attach_nonces` has `nonce` alone as the primary key
(`migrations/0041_*.sql`), and `burnSharedAgentNonce` inserts without the domain
(`src/fleet/shared-nonce-ledger.ts:41-45`). Domains share one namespace. Adding
`credential-claim:v1` makes three-plus protocols share it.

Practically negligible — nonces are 16–128 chars of base64url and an attacker cannot pre-burn
without a valid signature in *some* domain. But it is a latent coupling: a future protocol with
a shorter or structured nonce could collide, and the failure mode is a **silent refusal** of a
legitimate request (`replay`), which is miserable to debug. Recommend `(domain, nonce)` as the
PK in a future additive migration. Not blocking.

### 8.6 The response channel is the new weak point

`POST /api/credential/claim` returns plaintext over TLS. If the redeeming runtime is a shell
script with `set -x`, or a harness that logs response bodies, the secret is written to disk —
the same class of failure as today, just relocated. Mitigations are conventions, not code:
ship a reference redeemer under `fleet-runtime/` (alongside the existing
`attach-signed.mjs` referenced at `src/fleet/signed-attach.ts:42-43`) that writes the token
straight to a `0600` file and never echoes it, and document the failure mode loudly.

I want to be clear that this is a genuine limitation, not a solved problem. §7 item 3 of the "does
not fix" list says the same thing and it belongs in both places.

### 8.7 Dangling tickets

An issued, unredeemed ticket is standing authority to become an agent. Without a TTL it is
strictly worse than a token, because nobody thinks of it as a credential. Non-negotiable:
short TTL (propose 24h, tunable), a `list` surface, a `revoke` surface, and expiry surfaced
in `observatory` next to the key-presence column that already exists
(`src/dashboard/observatory.ts:277`).

### 8.8 Am I solving a problem that Option C solves better?

Honestly: partly. If the destination is signed-everything, the ticket is scaffolding. My
argument for building it anyway is that it is ~one table, one route, and zero new crypto, and
it unblocks the fleet now — whereas Option C is a multi-quarter re-architecture of MCP auth.
But the ticket path should be built so it can be *deleted*: no other subsystem should learn to
depend on `agent_credential_tickets`.

---

## 9. Rollout sequence

Deliberately sequenced so nothing must land tonight and each phase is independently
revertible. Phases 0 and 1 are the only ones that touch existing code paths.

**Phase 0 — prerequisite hardening (small, ships independently, ships FIRST)**
- operator-principal check on `register_agent_key` (`src/mcp/provision.ts:908`)
- extend `tests/provision-tools.test.ts:291` to cover it; mutation-check it
- decide + document the §10.1 breaking-change question
- *No dependency on anything below. This is worth doing whether or not the rest ships.*

**Phase 1 — split identity from credential**
- refactor `prepareAgentBoundTokenMintForBinding` (`src/members/service.ts:179`) into a shared
  identity-statement builder + a token-statement builder
- `mint_agent_token` composes both → byte-identical behaviour, proven by existing tests
- add `bind_agent_identity` composing only the identity builder
- gate: existing mint tests pass unchanged, with no test edits

**Phase 2 — tickets, issuance only**
- additive migration `agent_credential_tickets`
- `issue_credential_ticket` / `list_credential_tickets` / `revoke_credential_ticket`
- no redemption route yet; tickets are inert rows. Nothing can go wrong that a `DELETE`
  cannot fix.

**Phase 3 — redemption**
- register `'credential-claim:v1'` in `SHARED_NONCE_WINDOWS_SEC`
- `POST /api/credential/claim`
- adversarial review **in parallel** with the correctness gate — this is an eligibility/veto
  surface *and* an identity write path *and* external-facing, three of the four canonical
  sensitive surfaces

**Phase 4 — reference redeemer + one real seat**
- `fleet-runtime/claim-credential.mjs`, `0600` file output, no echo
- provision exactly one new seat end-to-end through the new path; keep the old path live
- receipt script in the existing `receipt:*` style (`package.json` scripts)

**Phase 5 — fleet migration, then reconsider deprecation**
- move seats over as they need re-issuance; do not force a flag day
- only after real mileage: decide whether `mint_agent_token` keeps returning `raw` (§10.2)

---

## 10. Open questions — for Hadi and River

**10.1 — Is adding the operator-principal check to `register_agent_key` a breaking change?**
It is a correctness fix, but if any agent-bound admin seat currently self-registers keys as
part of a working flow, it breaks that flow. I could not determine from the code whether this
is used in practice. Needs a check against production before Phase 0. *(For Hadi.)*

**10.2 — Should `mint_agent_token` eventually stop returning `raw`?**
My recommendation is to keep it indefinitely as the break-glass path and let the ticket become
the default by convention rather than by removal. But that means the leaking path stays
available forever, and conventions decay. The alternative — remove `raw` after Phase 5 — makes
the guarantee real at the cost of a flag day. *(For Hadi. This is a posture call, not a
technical one.)*

**10.3 — Is "holder of the registered key" equivalent to "the agent"?**
The whole design rests on yes. That is already the operative assumption of signed attach and
signed inbox, so answering no would invalidate shipped code, not just this proposal — but it
has never been stated as a principle anywhere I could find. It deserves to be written down
explicitly, because everything downstream inherits it. *(For River — this is an identity
question before it is a security question.)*

**10.4 — Key rotation.**
`registerAgentPublicKey` refuses implicit rotation by design
(`src/fleet/agent-keys.ts:108-114`). There is currently no rotation ceremony at all. A
compromised host key today means: delete the row via raw D1. If credentials become
key-derived, rotation stops being optional. Should Phase 6 be a rotation ceremony? *(For
Hadi.)*

**10.5 — Ticket TTL.**
24h proposed. Long enough for a human-in-the-loop handoff across timezones, short enough that
a forgotten ticket expires before it is forgotten about. Is that the right trade for how the
fleet actually operates? *(For Hadi.)*

**10.6 — Do the Nostr secp256k1/BIP340 keypairs minted for the Buzz relay belong here?**
**My answer: no — they are a distraction, and I recommend keeping them out.** Reasoning:
different curve, not in WebCrypto (`crypto.subtle` has no secp256k1), so using them means
`@noble/curves` — the first crypto runtime dependency (§3, A2). `agent_keys` is the
mupot-native identity (`migrations/0041`) and every signed surface in the pot verifies
against it. Two identity key systems for one agent is two things to rotate, two things to
revoke, and an ambiguity about which one *is* the agent. The Nostr key should stay what it
is: a relay-transport identity. Flagging it as a question rather than a decision only because
if there is a product reason to converge on one keypair fleet-wide, that reason lives outside
this document. *(For Hadi.)*

**10.7 — Does this actually unblock the stuck seats?**
Per §1.4, `flight_list` is a capability gate, not a binding gate. Before Phase 2, someone
should confirm for each stuck seat whether it is missing a *token*, missing a *grant*, or on
the *directory channel*. Three different fixes. Only the first is this document's problem.
*(For whoever holds the fleet-state picture.)*

---

## Appendix A — evidence index

Every claim above, re-verified in `/home/mumega/mupot/.wt/design` @ `96bdb73`.

| Claim | Citation |
|---|---|
| mint returns raw token | `src/mcp/provision.ts:494`, `:504` |
| second leaking mint path | `src/members/agent-connection.ts:711` via `src/mcp/provision.ts:810` |
| dashboard mint is CSRF/cookie only | `src/dashboard/index.ts:228`, `:1731` |
| agents forbidden from minting | `src/mcp/provision.ts:437`; rationale `:13-18` |
| escalation guard hard-cap | `src/members/service.ts:226-229`, `:286-293`; `src/mcp/provision.ts:455-460` |
| tokens hashed at rest | `src/members/service.ts:211`, `:235-237` |
| `send`/`inbox` need binding | `src/mcp/index.ts:2164`, `:2242`, `:2342` |
| `connect` yields session_local | `src/mcp/index.ts:2990-2994` |
| directory channel drops binding | `src/mcp/index.ts:166`, `:2930` |
| `flight_list` needs observer, not binding | `src/mcp/index.ts`, `flight_list.run` |
| Ed25519 public keys | `migrations/0041_*.sql`; `src/fleet/agent-keys.ts:67-77` |
| signed attach protocol | `src/fleet/signed-attach.ts:48-59`, `:118-221` |
| bearer-free routes | `src/fleet/attach-routes.ts:249-280`; `src/agents/inbox-routes.ts:87-100` |
| no signed send | `src/agents/inbox-routes.ts:103-156` (bearer-only) |
| shared nonce ledger + domains | `src/fleet/shared-nonce-ledger.ts:3-23`, `:25-49` |
| inbox fence | `migrations/0058_*.sql`; `src/agents/messages.ts:377`, `:383-392` |
| fence flip is admin-only | `src/mcp/index.ts:2396`, `:2406`, `:2428` |
| key registration needs prior mint | `src/fleet/agent-keys.ts:91-103`; `src/mcp/provision.ts:935-937` |
| binding written only by mint | `src/members/service.ts:222-225`; backfill `migrations/0071_*.sql:78` |
| binding immutable | `migrations/0071_*.sql:108-112`, `:134` |
| **`register_agent_key` unguarded** | `src/mcp/provision.ts:908` vs `:437`/`:534`/`:589`/`:711`/`:833` |
| **test omits it** | `tests/provision-tools.test.ts:291-315` |
| ceiling dropped 2026-08-09 | `migrations/0087_drop_home_capability_ceiling.sql` |
| agents can hold admin | `src/mcp/provision.ts:80`; `tests/provision-tools.test.ts:284` |
| bearer-attach downgrade block | `src/fleet/attach-routes.ts:213-215` |
| AES-GCM/HKDF prior art | `src/connectors/crypto.ts:1-25`; `src/types.ts:202` |
| no crypto runtime deps | `package.json` dependencies (4, none cryptographic) |
| compat date / nodejs_compat | `wrangler.example.toml:8-9` |
