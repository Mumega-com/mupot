# Federated Sovereign Control Plane - design + handoff (Phase 0 ADR)

Status: Phase 0 draft, 2026-08-03.
Owner: unassigned - delegated to codex + cursor, 2026-07-29.
Decision scope: ADR + threat model + per-product Cloudflare capability matrix.
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
itself. If auto-minting is unavoidable in a later phase, the broker token must be bootstrap-only:
no other permissions, IP-restricted + short TTL, used in an isolated job, then revoked immediately
after minting the scoped child. **IP-lock alone is not sufficient against host compromise/SSRF**.
Cloudflare warns that a token able to create tokens can create tokens over its authorized resources
and recommends no additional permissions plus IP or TTL restrictions.

### Operations

Health+redeploy is insufficient. Cloudflare exposes real per-product APIs: D1 requires D1
Read/Edit; Queues exposes list/consumer/backlog operations; Workers logs remain in each account
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
6. A persistent token-minting root is out of scope. The Phase 0 capability matrix must not grant
   `API Tokens Write`, `API Tokens Edit`, or `Account API Tokens Write` to any runtime capability.

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

| Acceptance attack | Named test | Required assertion | Evidence artifact |
|---|---|---|---|
| Tenant token isolation | `phase0-tenant-token-isolation` | Pilot token succeeds only on the pilot account and returns `403` for the same endpoint against central account `e39eaf94...` and a second tenant-owned account | `evidence/federated-control-plane/phase0/tenant-token-isolation.json` |
| Compromised tenant Worker isolation | `phase0-compromised-worker-admin-deny` | Tenant runtime has no central credential and a simulated compromised Worker receives `401`/`403` from central admin APIs | `evidence/federated-control-plane/phase0/compromised-worker-admin-deny.json` |
| Health target SSRF resistance | `phase0-health-target-ssrf-deny` | Loopback, link-local, private, redirect-to-private, non-HTTPS, and unregistered hosts are rejected before a network request | `evidence/federated-control-plane/phase0/health-target-ssrf-deny.json` |
| Stale generation fencing | `phase0-stale-generation-cas-deny` | A lower or replayed generation cannot overwrite a newer desired/observed generation | `evidence/federated-control-plane/phase0/stale-generation-cas-deny.json` |
| Immediate revocation | `phase0-revoked-token-immediate-stop` | After revocation, the next attempted control action is denied and no later reconciliation is accepted from the cached credential | `evidence/federated-control-plane/phase0/revoked-token-immediate-stop.json` |
| Zero credentials in registry | `phase0-registry-zero-credentials` | Schema, rows, logs, exports, and backups contain secret references only and reject token-shaped material | `evidence/federated-control-plane/phase0/registry-zero-credentials.json` |

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
| Build artifact drift | Unsigned or substituted artifact executes | Digest lock + signed manifest hash + generation checks |
| Callback tampering | Untrusted postback path changes result | Replay window, callback signature, tenant-scoped routing |
| SSRF | Unbounded health target reaches internal services | Canonical allowlist, scheme/host/path lock, DNS/IP revalidation, no arbitrary fetch |
| Central compromise | Registry leak becomes cloud-wide control | Metadata-only registry separated from per-tenant deploy capabilities and runners |

## 5. Per-product Cloudflare capability matrix (Phase 0 minimums)

Cloudflare permission-group names below are the documented names, not invented `resource:verb`
aliases. At token creation, resolve and record each immutable permission-group **ID** from the
account permission-groups API; names are review labels and may change.

Mupot policy for all rows:

- Bind account-scoped policies to exactly
  `"com.cloudflare.api.account.<TENANT_ACCOUNT_ID>": "*"`; never use the all-accounts wildcard.
- Bind zone-scoped policies to the exact tenant zone ID. An account grant is not a substitute for
  a zone binding.
- Carry read and write grants in separate tokens: `observe-read` never receives an Edit/Write
  group; `deploy-write` never receives Logs/Tail access; `break-glass/JIT-support` is separately
  tenant-approved.
- Set `expires_on` as an absolute UTC timestamp. Local maximum lifetime is 30 days for
  `observe-read`, 7 days for `deploy-write`, and 60 minutes for `break-glass/JIT-support`.
- Store only token secret references plus the permission-group IDs, exact resource IDs,
  `issued_on`, `expires_on`, and revocation receipt ID in the central registry.

| Product / operation | Documented read group | Documented write group | Exact resource binding | `expires_on` maximum | Capability carrier |
|---|---|---|---|---|---|
| Workers scripts, Durable Objects, and Workflows | `Workers Scripts Read` | `Workers Scripts Edit` | Exact tenant account ID | read: 30d; write: 7d | read: `observe-read`; write: `deploy-write` |
| D1 | `D1 Read` | `D1 Edit` | Exact tenant account ID | read: 30d; write: 7d | read: `observe-read`; write: `deploy-write` |
| Queues | `Queues Read` | `Queues Edit` | Exact tenant account ID | read: 30d; write: 7d | read: `observe-read`; write: `deploy-write` |
| Workers KV | `Workers KV Storage Read` | `Workers KV Storage Edit` | Exact tenant account ID | read: 30d; write: 7d | read: `observe-read`; write: `deploy-write` |
| R2 | `Workers R2 Storage Read` | `Workers R2 Storage Edit` | Exact tenant account ID; exact bucket binding where supported | read: 30d; write: 7d | read: `observe-read`; write: `deploy-write` |
| Worker routes | `Workers Routes Read` | `Workers Routes Edit` | Exact tenant zone ID | read: 30d; write: 7d | read: `observe-read`; write: `deploy-write` |
| Live Worker tail | `Workers Tail Read` | none | Exact tenant account ID | 60m | `break-glass/JIT-support` only |
| Logpull / Logpush / Instant Logs | `Logs Read` | `Logs Edit` only when export configuration must change | Exact account or zone ID required by the endpoint | 60m | `break-glass/JIT-support` only |

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
account's own Super Administrator**. No real token may be minted or requested until Hadi gives the
existing direct approval.

The evidence manifest must record full IDs for:

1. the central Mumega account (`e39eaf94...`),
2. the pilot separate-ownership account,
3. a second tenant-owned account used only as the other negative boundary,
4. the tested token ID/hash reference, creator account and role, exact permission-group IDs,
   resource bindings, `issued_on`, `expires_on`, tested commit, and revocation receipt.

`phase0-tenant-token-isolation` must contain a positive pilot request and paired negative requests
using the same pilot token and endpoint shape: `403` against `e39eaf94...` and `403` against the
second tenant account. Both negative results are mandatory; positive-only evidence is a BLOCK.

Current status: design and matrix are documented. Separate-ownership execution evidence is
pending direct credential/governance approval and must not be inferred from the shared-account
digid/viamar proof.

## 7. Phase map

- **Phase 0** - ADR + threat model + capability matrix + separate-ownership account test proof.
- **Phase 1** - read-only registry + signed attestation + health/drift.
- **Phase 2** - idempotent fenced reconciler; no dashboard shell-out.
- **Phase 3** - minimized push telemetry.
- **Phase 4** - tenant-approved JIT support.

## 8. Delegation and narrow Hadi decision boundary

- **codex** owns Phase 0 (ADR + threat model + capability matrix). Phase 1-4 issues wait until
  Phase 0 lands.
- **cursor** is available for parallel-track Phase 1 implementation after Phase 0 lands.
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
