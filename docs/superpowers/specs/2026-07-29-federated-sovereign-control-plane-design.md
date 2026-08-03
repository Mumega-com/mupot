# Federated Sovereign Control Plane - design + handoff (Phase 0 ADR)

Status: Proposed Phase 0 ADR, 2026-08-03; not accepted or complete until Section 7 holds.
Owner: unassigned - delegated to codex + cursor, 2026-07-29.
Decision scope: this design artifact covers the ADR, threat model, and per-product Cloudflare
capability matrix. Phase 0 completion additionally requires the evidence predicate in Section 7.
Hard constraints: branch+PR workflow, dyad-gate required for sensitive surface changes, no
deploy/merge from this branch, and no real broker-token mint against tenant Cloudflare accounts
without direct Hadi approval.

## 1. Journey (how we got here, 2026-07-29 session)

1. Cleaned up stale Cloudflare Zero Trust Access apps on the mumega Cloudflare account
   (`e39eaf94...`): deleted `Digid (staging)`, `Viamar (staging)`, `Customer Dashboard`
   (`*.mumega.com/dashboard*` - overprovisioned, single policy, Include=Everyone,
   Require=none, IdP=One-Time-PIN, 168h session), and `Mumega Dashboard`
   (`app.mumega.com`, dead / non-proxied DNS). Kept only Warp Login + Google Drive SAML.
   End state: **no Cloudflare Access app protects `mupot.mumega.com` anymore**; Mupot login
   itself is now the gate.
2. Verified `digid.mumega.com` / `viamar.mumega.com` still resolve but remain public marketing
   content on shared hosting via `x-tenant: <slug>` header routing.
3. Stopped legacy `dashboard.service` (`python3 -m sos.services.dashboard` on
   `ubuntu-16gb-ash-1`) and confirmed it had no Mupot code path. Left non-Mupot endpoints
   unchanged (`/auth`, `/signup`, Dialogflow webhook, A2A routes).
4. Problem statement: tenants should operate from one control pane at `mupot.mumega.com` while
   each tenant's compute/data lives in their own Cloudflare account, not shared or unmanaged.
5. Current reality: digid/viamar are still deployed from the shared mumega Cloudflare account;
   broker token flow never reached a real separate-ownership account in production.
6. Sent the case to Codex for reviewed opinion and preserved a paraphrased synthesis below.

## 2. Codex's studied opinion (paraphrased synthesis, 2026-07-29 22:06-22:07 UTC)

**Verdict: direction right, initial design wrong.** A thin central registry (metadata only)
is appropriate, but "registry + health-check + redeploy button" is **inventory, not a control
plane**. Two structural flaws in the original proposal:

1. A **persistent `Account API Tokens:Edit` broker** sitting in our infra is a token-minting
   root - too powerful to hold long-term.
2. A **dashboard action that shells directly into tenant-specific Wrangler state** - no
   separation between "decide" and "execute."

### Credentials

Preferred onboarding: the tenant's own Super Admin creates the deploy token directly (prefilled
Cloudflare token-template URL, scoped to that one account + exact products) - not us minting it.
Three separate capabilities, never one omnibus token: **deploy-write**, **observe-read**,
**break-glass/JIT-support**. Registry D1 stores only secret-store *references*, never the token
itself. This ADR does not authorize auto-minting in a later phase. Any proposal to introduce an API
token-management permission requires a separate ADR amendment, Hadi's direct approval, and parallel
correctness + adversarial GREEN gates before implementation. That amendment must constrain the
broker to an isolated bootstrap job with no other permissions, IP restriction, a hard TTL, and a
mandatory revocation receipt immediately after minting the scoped child. **IP-lock alone is not
sufficient against host compromise/SSRF**. Cloudflare warns that a token able to create tokens can
create tokens over its authorized resources and recommends no additional permissions plus IP or
TTL restrictions.

### Operations

Health+redeploy is insufficient. Cloudflare exposes real per-product APIs: D1 requires D1
Read/Write; Queues exposes list/consumer/backlog operations; Workers logs remain in each account
while Tail Workers/OTEL/Logpush can push telemetry centrally. This needs an explicit per-product
capability matrix, not one blanket scope. The central dashboard defaults to **metadata only**:
desired-vs-observed release digest, config-hash drift, last reconciliation, health, queue
aggregates, and cost/limit signals. Full logs and D1 business-data queries are
**tenant-approved JIT support, not standing access**. Central telemetry is minimized and redacted
because logs can carry tenant data.

### Blast radius + adjacent systems

A leaked child deploy token should mutate only that tenant's granted resources, with **zero
credential accepted by central admin APIs**. Indirect paths to guard include SSRF via an
attacker-controlled health-check URL, forged callbacks/heartbeats, poisoned logs, malicious build
artifacts, and tenant code receiving central secrets. Controls include canonical validated
endpoints, signed replay-protected telemetry, build-once signed artifact digests, no central secret
in tenant runtime, and an isolated per-tenant deploy runner. Registry leak means metadata/refs
only; vault/control-plane compromise can mean fleet-wide control, so those blast radii remain
separate by design.

- **BYOA (runtime-adapter/v1) is adjacent, not duplicate:** this infra adapter provisions and
  returns a runtime manifest; BYOA governs the agent harness running on that substrate. They share
  only identity/capability/receipt contracts.
- **Workers for Platforms does not satisfy tenant-account sovereignty:** dispatch namespaces use
  platform-owned account/billing/resources and are not a substitute for separate tenant accounts.

### Recommended epic shape - Federated Sovereign Control Plane

- **Phase 0** - ADR + threat model + capability matrix, tested against a genuinely
  separate-ownership Cloudflare account. The current digid proof did not test that boundary.
- **Phase 1** - read-only registry, signed attestation, health/drift.
- **Phase 2** - idempotent fenced reconciler deploys one pinned artifact + D1 through a direct
  scoped account token; no dashboard shell-out and no arbitrary config path.
- **Phase 3** - minimized push telemetry.
- **Phase 4** - tenant-approved JIT support.

## 3. ADR decision (Phase 0 scope)

1. Proceed with a federated model: **central metadata registry + tenant-owned bounded account
   capabilities + signed control telemetry**.
2. Do not create a full multi-tenant database in one account for Phase 0.
3. `tenants` and onboarding metadata are non-secret, registry-only, and tenant-scoped.
4. Central operations remain "decide first, execute second" through a signed, fenced reconciler.
5. JIT support remains tenant-approved; it never becomes a standing right.
6. API token-management permission is prohibited from every runtime capability in every phase,
   not only Phase 0. Reintroduction requires the separately approved ADR amendment and gates in
   Section 2; no implementation task or later-phase label implicitly overrides this ratchet.
7. Removing the old, overprovisioned Cloudflare Access application is historical cleanup, not an
   acceptance of Mupot-login-only as the final control-plane posture. Before Phase 0 closes or any
   tenant runtime capability is enabled, Hadi must directly approve either: (a) a least-privilege
   independent edge gate with phishing-resistant MFA plus device/network posture, or (b) a written
   accepted-risk decision demonstrating equivalent phishing-resistant MFA, session, and posture
   controls in Mupot. Include=Everyone, OTP-only, and 168-hour sessions are prohibited.

## 4. Threat model

### 4.1 Trust boundaries

| Boundary | In scope | Out of scope |
|---|---|---|
| Tenant onboarding and control plane | Tenant metadata, deploy intent, capability intents, token references | Child account secrets, raw credentials, cross-tenant state |
| Reconciler service | Signed, audited execute intent, generation checks, idempotent deploy/apply | Direct host shelling, arbitrary file writes, unbounded network fetch |
| Registry | Tenants, manifest versions, control receipts, per-tenant config digests | Token material, secrets, shared tenant data |
| Tenant workload | Hosted runtime, queues, D1, bindings inside the tenant account | Central control credentials, other tenants' data |

### 4.2 Acceptance attacks - must all hold before ship

Every row is a merge gate. A verbal result, screenshot alone, or positive-path-only run does not
satisfy it. The named test must pass and its machine-readable evidence artifact must be attached to
the PR at the tested commit.

Artifact paths below are logical keys in protected Mupot Project Evidence, not instructions to
commit tenant identifiers or credential metadata to the public repository. The PR records only the
evidence receipt URI, SHA-256 digest, tested commit, account-ID prefixes, and gate verdict. Before
Phase 0 can be accepted, a checked-in JSON Schema and CI verifier must reject unsigned, malformed,
wrong-commit, or manually self-attested evidence.

Phase 0 produces this evidence through a bounded, non-production conformance harness. The harness
may exercise tenant-owned pilot credentials only with Hadi's direct approval, but it does not deploy
or activate the production control plane. It validates the permission, isolation, signature,
revocation, and pure state-transition contracts that later runtime phases must preserve.

| Acceptance attack | Named test | Required assertion | Evidence artifact |
|---|---|---|---|
| Tenant token isolation | `phase0-tenant-token-isolation` | Pilot token succeeds only on the pilot account and returns `403` for the same endpoint against central account `e39eaf94...` and a second tenant-owned account | `mupot-evidence://project/<PROJECT_ID>/federated-control-plane/phase0/tenant-token-isolation.json` |
| Compromised tenant Worker isolation | `phase0-compromised-worker-admin-deny` | Tenant runtime has no central credential and a simulated compromised Worker receives `401`/`403` from central admin APIs | `mupot-evidence://project/<PROJECT_ID>/federated-control-plane/phase0/compromised-worker-admin-deny.json` |
| Health target SSRF resistance | `phase0-health-target-ssrf-deny` | Loopback, link-local, private, redirect-to-private, non-HTTPS, and unregistered hosts are rejected before a network request | `mupot-evidence://project/<PROJECT_ID>/federated-control-plane/phase0/health-target-ssrf-deny.json` |
| Stale generation fencing | `phase0-stale-generation-cas-deny` | A lower or replayed generation cannot overwrite a newer desired/observed generation | `mupot-evidence://project/<PROJECT_ID>/federated-control-plane/phase0/stale-generation-cas-deny.json` |
| Immediate revocation | `phase0-revoked-token-immediate-stop` | After revocation, the next attempted control action is denied and no later reconciliation is accepted from the cached credential | `mupot-evidence://project/<PROJECT_ID>/federated-control-plane/phase0/revoked-token-immediate-stop.json` |
| Zero credentials in registry | `phase0-registry-zero-credentials` | Schema, rows, logs, exports, and backups contain secret references only and reject token-shaped material | `mupot-evidence://project/<PROJECT_ID>/federated-control-plane/phase0/registry-zero-credentials.json` |
| No token-minting root | `phase0-no-token-mint-permission` | For every runtime token, the token-read response's resolved permission-group ID set excludes all API-token and account-API-token management Write/Edit groups | `mupot-evidence://project/<PROJECT_ID>/federated-control-plane/phase0/no-token-mint-permission.json` |
| Signature verification boundary | `phase0-signature-verification-boundary` | Reject unsigned payloads, `alg:none`, unapproved algorithms, unknown/caller-supplied key IDs, cross-tenant signers, forged signatures, and revoked keys before state change | `mupot-evidence://project/<PROJECT_ID>/federated-control-plane/phase0/signature-verification-boundary.json` |
| Signer compromise and rotation | `phase0-signer-key-lifecycle` | Rotation overlap accepts only current/next trusted keys; compromise revocation immediately rejects the old key, halts affected reconciliation, and emits an audit receipt | `mupot-evidence://project/<PROJECT_ID>/federated-control-plane/phase0/signer-key-lifecycle.json` |
| Control-plane front-door authentication | `phase0-control-plane-auth-boundary` | Missing phishing-resistant MFA or required edge/device/network posture, unauthenticated, expired-session, cross-tenant, and replayed-session requests cannot reach Mupot control APIs | `mupot-evidence://project/<PROJECT_ID>/federated-control-plane/phase0/control-plane-auth-boundary.json` |

For tenant isolation, Phase 0 selects and records a Cloudflare endpoint whose documented denial for
the tested cross-account condition is `403`. The assertion also requires non-2xx and zero tenant
resource data in the response body. A different observed status does not permit an ad hoc loosened
gate; it blocks the evidence specification until the endpoint and expected Cloudflare error code
are reviewed in this ADR.

### 4.3 Attack vectors

| Vector | Failure mode | Control |
|---|---|---|
| Credential misuse | Root or omnibus token remains standing | Tenant-minted split tokens, hard expiry, immediate revoke path, no token-mint permission in runtime matrix |
| Tenant isolation breach | Shared metadata becomes a cross-tenant transport | Tenant manifest, secret reference, target account ID, and signed intent must resolve to one tenant |
| Confused deputy | Reconciler uses Tenant A's credential for Tenant B's requested account | Bind signed intent to tenant ID + exact account ID; reject any secret-ref/account mismatch before secret retrieval |
| Revoked credential from cache | Runner continues with an in-memory credential after revocation | Short-lived process cache, revocation epoch checked before each mutation, halt and purge on mismatch |
| Spoofed telemetry | Fake heartbeat or reconcile status | Signed payloads, nonce/epoch monotonic checks, signer-to-tenant binding |
| Telemetry content poisoning | Logs or status fields inject instructions, markup, or forged state | Treat telemetry as untrusted data, schema/size constrain it, escape rendering, redact before central storage |
| Audit-chain integrity | Control receipts are removed, reordered, or rewritten | Append-only hash-linked receipts, signed sequence/generation, independent verification and gap alarms |
| Control-plane front-door bypass | Mupot application auth is the only remaining public control-plane gate | Short sessions, replay resistance, tenant-scoped authorization on every control route, independent auth-boundary acceptance test |
| Build artifact drift | Unsigned or substituted artifact executes | Digest lock + signed manifest hash + generation checks |
| Callback tampering | Untrusted postback path changes result | Replay window, callback signature, tenant-scoped routing |
| SSRF | Unbounded health target reaches internal services | Canonical allowlist, scheme/host/path lock, DNS/IP revalidation, no arbitrary fetch |
| Central compromise | Registry leak becomes cloud-wide control | Metadata-only registry separated from per-tenant deploy capabilities and runners |

### 4.4 Signing-key custody and compromise

- Every signing key has an immutable `key_id`, tenant ID, purpose (`intent`, `telemetry`,
  `artifact`, or `receipt`), approved algorithm, `not_before`, `expires_on`, and revocation epoch in
  the trusted registry. A request cannot supply its own verification key, algorithm, or key URL.
- Private keys never enter the metadata registry. Tenant telemetry keys remain in tenant-owned
  secret custody; central intent/receipt keys remain outside tenant runtime. The verifier resolves
  a trusted public key by the signed tenant + purpose + `key_id` tuple before parsing action data.
- The algorithm allowlist is explicit and contains no `none` mode or algorithm fallback. Signer,
  tenant, purpose, generation, and payload digest are all covered by the signature.
- Rotation uses bounded current/next overlap and records an activation + retirement receipt.
  Compromise advances the revocation epoch, purges verifier caches, halts the affected tenant lane,
  and requires re-attestation before reconciliation resumes.

Controls that become executable after Phase 0 retain named future gates:

| Threat vector | Proving phase | Required named test |
|---|---|---|
| Confused deputy | Phase 2 | `phase2-tenant-account-secretref-binding` |
| Spoofed telemetry | Phase 3 | `phase3-telemetry-signature-replay-deny` |
| Telemetry content poisoning | Phase 3 | `phase3-telemetry-untrusted-content` |
| Audit-chain integrity | Phase 1 | `phase1-control-receipt-chain-integrity` |
| Build artifact drift | Phase 2 | `phase2-signed-artifact-digest-fence` |
| Callback tampering | Phase 3 | `phase3-callback-signature-replay-deny` |

## 5. Per-product Cloudflare capability matrix (Phase 0 minimums)

Cloudflare permission-group names below are the documented names, not invented `resource:verb`
aliases. At token creation, resolve and record each immutable permission-group **ID** from the
account permission-groups API; names are review labels and may change.

Mupot policy for all rows:

- Bind account-scoped policies to exactly
  `"com.cloudflare.api.account.<TENANT_ACCOUNT_ID>": "*"`; never use the all-accounts wildcard.
- Bind zone-scoped policies to the exact tenant zone ID. An account grant is not a substitute for
  a zone binding.
- Carry read and write grants in separate tokens: `observe-read` never receives a Write/Edit
  group; `deploy-write` never receives Logs/Tail access; `break-glass/JIT-support` is separately
  tenant-approved.
- Set `expires_on` as an absolute UTC timestamp. Local maximum lifetime is 7 days for
  `observe-read` and `deploy-write`, and 60 minutes for `break-glass/JIT-support`. Rotate
  seven-day tokens by day 5, revoke the superseded token with a receipt, and run a monthly
  revocation drill.
- Store only token secret references plus the permission-group IDs, exact resource IDs,
  `issued_on`, `expires_on`, and revocation receipt ID in the central registry.

| Product / operation | Documented read group | Documented write group | Exact resource binding | `expires_on` maximum | Capability carrier |
|---|---|---|---|---|---|
| Workers scripts, Durable Objects, and Workflows | `Workers Scripts Read` | `Workers Scripts Write` | Exact tenant account ID | read: 7d; write: 7d | read: `observe-read`; write: `deploy-write` |
| D1 | `D1 Read` | `D1 Write` | Exact tenant account ID | read: 7d; write: 7d | read: `observe-read`; write: `deploy-write` |
| Queues | `Queues Read` | `Queues Write` | Exact tenant account ID | read: 7d; write: 7d | read: `observe-read`; write: `deploy-write` |
| Workers KV | `Workers KV Storage Read` | `Workers KV Storage Write` | Exact tenant account ID | read: 7d; write: 7d | read: `observe-read`; write: `deploy-write` |
| R2 | `Workers R2 Storage Read` | `Workers R2 Storage Write` | Exact tenant bucket resource; fail closed if the operation cannot be bucket-scoped | read: 7d; write: 7d | read: `observe-read`; write: `deploy-write` |
| Worker routes | `Workers Routes Read` | `Workers Routes Write` | Exact tenant zone ID | read: 7d; write: 7d | read: `observe-read`; write: `deploy-write` |
| Live Worker tail | `Workers Tail Read` | none | Exact tenant account ID | 60m | `break-glass/JIT-support` only |
| Logpull / Instant Logs | `Logs Read` | none | Exact account or zone ID required by the endpoint | 60m | `break-glass/JIT-support` only |

The runtime control plane receives no `Logs Write` capability. A tenant configures any persistent
Logpush destination manually in its own account under a separately reviewed destination allowlist;
token expiry is not a teardown mechanism and must never be presented as one.

Durable Objects and Workflows intentionally have no standalone matrix rows: Cloudflare's Durable
Objects namespace API accepts `Workers Scripts Read` / `Workers Scripts Write`, and the Workflows
API accepts `Workers Scripts Read` / `Workers Scripts Write` (plus `Workers Tail Read` for
applicable reads). They therefore remain folded into the Workers Scripts permission boundary.
Before minting, the implementation must reconcile the current API-returned group name/ID. If the
live permission-group list disagrees with this table, fail closed and update this ADR through a
reviewed PR; do not broaden the token.

## 6. Separate-ownership account evidence gate

Phase 0 is not proven by a second account controlled by the same Mumega owner. The pilot must be a
genuinely separate-ownership Cloudflare account, and its deploy token must be created by **that
account's own Super Administrator**. No real token may be minted or requested until Hadi grants
the required direct approval for that named pilot and test.

The protected evidence manifest must record full IDs for:

1. the central Mumega account (`e39eaf94...`),
2. the pilot separate-ownership account,
3. a second tenant-owned account used only as the other negative boundary,
4. the tested token ID/hash reference, creator account and role, exact permission-group IDs,
   resource bindings, `issued_on`, `expires_on`, tested commit, and revocation receipt.

The public PR and repository must contain only account-ID prefixes plus a signed receipt URI and
digest. Full tenant account IDs remain in the access-controlled evidence store.

`phase0-tenant-token-isolation` must contain a positive pilot request and the paired negative
requests defined in Section 4.2, using the same pilot token and endpoint shape against
`e39eaf94...` and the second tenant account. Section 4.2's documented-endpoint/error-code predicate
is authoritative. Both negative results are mandatory; positive-only evidence is a BLOCK.

Current status: design and matrix are documented. Separate-ownership execution evidence is
pending direct credential/governance approval and must not be inferred from the shared-account
digid/viamar proof.

## 7. Phase map

Landing this ADR does **not** complete Phase 0 and does not unlock Phase 1. Phase 0 closes only when
all of the following hold at one immutable tested commit:

1. the evidence JSON Schema and CI verifier are merged and passing,
2. Hadi has directly approved the named separate-ownership pilot/test and the front-door posture,
3. every Section 4.2 evidence receipt verifies, including separate-account negative boundaries,
4. review-worker and kasra-review are GREEN on the exact evidence-bearing head, and
5. the gate owner records the final Phase 0 verdict and receipt digest in Mupot Project Evidence.

- **Phase 0** - closes only under the predicate above; ADR + threat model + matrix alone are not
  completion.
- **Phase 1** - read-only registry + signed attestation + health/drift; starts only after Phase 0
  closes.
- **Phase 2** - idempotent fenced reconciler; no dashboard shell-out.
- **Phase 3** - minimized push telemetry.
- **Phase 4** - tenant-approved JIT support.

## 8. Delegation and narrow Hadi decision boundary

- **codex** owns the Phase 0 design artifact. Phase 1-4 issues wait until Phase 0 satisfies the
  Section 7 completion predicate; merging this ADR alone does not release them.
- **cursor** is available for parallel-track Phase 1 implementation only after Phase 0 satisfies
  the Section 7 completion predicate.
- **Standing rules apply unchanged:** branch + PR only, never merge to main without dyad-gate
  GREEN, no deploy, and no minting real broker tokens against a tenant account without Hadi's
  direct go. This touches external-facing and credential-mint sensitive surfaces, so the
  adversarial gate runs **in parallel** with the correctness gate, not after it.
- If genuinely blocked on a decision only Hadi can make - specifically which tenant owns the first
  real separate-account pilot or whether its Super Administrator may mint the test token - file a
  tracked GitHub issue with that decision clearly framed. Continue only unrelated design work;
  do not treat the issue as permission to mint, deploy, merge, or bypass the gate.

## 9. Cloudflare sources

- API token permission names and resource scopes:
  https://developers.cloudflare.com/fundamentals/api/reference/permissions/
- Account-owned tokens and Super Administrator creation requirement:
  https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/
- Token policy resource syntax, permission-group IDs, `expires_on`, and creation warnings:
  https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/
- Runtime IP and TTL restrictions:
  https://developers.cloudflare.com/fundamentals/api/how-to/restrict-tokens/
- Live account-owned permission-group discovery:
  https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/subresources/permission_groups/methods/list/
- Durable Objects namespace accepted permissions:
  https://developers.cloudflare.com/api/resources/durable_objects/subresources/namespaces/methods/list/
- Workflows accepted permissions:
  https://developers.cloudflare.com/api/resources/workflows/methods/list/
- Workers for Platforms ownership boundary:
  https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/
- Tail Workers observability model:
  https://developers.cloudflare.com/workers/observability/logs/tail-workers/
