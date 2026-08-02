# Federated Sovereign Control Plane — design + handoff (Phase 0 ADR)

Status: Phase 0 draft, 2026-08-02.
Owner: Hadi + kasra + codex (delegated).
Decision scope: ADR + threat model + per-product Cloudflare capability matrix.
Hard constraints (still in force): branch+PR workflow, dyad-gate required for sensitive
surface changes, no deploy/merge from this branch, no real broker-token mint against tenant CF
accounts without direct Hadi approval.

## 1. Journey (how we got here, 2026-07-29 session)

1. Cleaned up stale Cloudflare Zero Trust Access apps on the mumega CF account
   (`e39eaf94…`): deleted `Digid (staging)`, `Viamar (staging)`, `Customer Dashboard`
   (`*.mumega.com/dashboard*` — overprovisioned, single policy, Include=Everyone,
   Require=none, IdP=One-Time-PIN, 168h session), and `Mumega Dashboard`
   (`app.mumega.com`, dead / non-proxied DNS). Kept only Warp Login + Google Drive SAML.
   End state: **no CF Access app protects `mupot.mumega.com` anymore**; mupot login itself is now
   the gate.
2. Verified `digid.mumega.com` / `viamar.mumega.com` still resolve but remain public marketing
   content on shared hosting via `x-tenant: <slug>` header routing.
3. Stopped legacy `dashboard.service` (`python3 -m sos.services.dashboard` on
   `ubuntu-16gb-ash-1`) and confirmed it had no mupot code path. Left non-mupot
   endpoints unchanged (`/auth`, `/signup`, Dialogflow webhook, A2A routes).
4. Problem statement: tenants should operate from one control pane at `mupot.mumega.com` while
   each tenant’s compute/data lives in their own Cloudflare account, not shared or unmanaged.
5. Current reality: digid/viamar are still deployed from the shared mumega CF account; broker token
   flow never reached a real separate account in production.
6. Sent case to Codex for reviewed opinion and preserved response text in this doc.

## 2. Codex’s studied opinion (verbatim synthesis, 2026-07-29 22:06–22:07 UTC)

**Verdict: direction right, initial design wrong.** A thin central registry (metadata only)
is appropriate, but "registry + health-check + redeploy button" is **inventory, not a control
plane**. Two structural flaws in the original proposal:

1. A **persistent `Account API Tokens:Edit` broker** sitting in our infra is a token-minting
   root — too powerful to hold long-term.
2. A **dashboard action that shells directly into tenant-specific Wrangler state** — no
   separation between "decide" and "execute."

### Credentials

Preferred onboarding: tenant’s own Super Admin creates the deploy token directly (prefilled
Cloudflare token-template URL, scoped to that account + exact products) — not us minting it.
Three separate capabilities, never one omnibus token: **deploy-write**, **observe-read**,
**break-glass/JIT-support**.

Registry D1 stores only secret-store *references*, never the token itself.
If auto-minting is unavoidable, the broker token must be bootstrap-only:
no other permissions, IP-restricted + short TTL, isolated job, revoked immediately after
minting scoped child token. IP-lock alone is insufficient against host compromise/SSRF;
CF docs already warn `Account-API-Tokens:Edit` can mint tokens across all authorized resources.

### Operations

Health+redeploy alone is insufficient. Per-product Cloudflare APIs are needed with scoped,
tenant-approved access controls:

- D1 REST (`Read`/`Write` by scope)
- Queues (`list`, `consumers`, `backlog` metrics)
- Workers Logs / Tail + Logpush / OTEL export (JIT, tenant-approved)
- Durable Objects and Workflows (tenant-owned artifact orchestration)
- KV/R2 only where required and only for tenant-owned buckets

Central dashboard should stay metadata-first: digest drift, config hash, last reconciliation,
health and queue metrics only. Full logs / business data must be **JIT tenant-approved**.

### Blast-radius boundaries

Separate registry leak from deploy-control leak:

- A leaked child deploy token mutates only that tenant’s resources and cannot call central APIs.
- A central-compromise leak should not become fleet-wide account control.
- No central secrets are ever injected into tenant runtime env.
- Health-check endpoints are canonical, signed, and replay-protected; no URL-driven shelling.

### Non-goals for phase 0

- BYOA runtime adapter is adjacent only; it does **not** define control-plane ownership.
- Workers for Platforms dispatch namespaces are **not** sovereign-account control-plane strategy.

## 3. ADR decision (Phase 0 scope)

1. Proceed with a federated model: **central metadata registry + tenant-owned bounded account
   capabilities + signed control telemetry**.
2. No full multi-tenant DB in one account for phase 0.
3. `tenants` table and onboarding metadata are strictly non-secret, registry-only and scoped by
   tenant slug.
4. Central operations stay "decide first, execute second" with a signed, fenced reconciler path.
5. JIT support workflows remain tenant-approved, never standing rights.

## 4. Threat model

### 4.1 Trust boundaries

| Boundary | In scope | Out of scope |
|---|---|---|
| Tenant onboarding and control plane | Tenant metadata, deploy intent, capability intents, token references | Child account secrets, raw credentials, cross-tenant state |
| Reconciler service | Signed, audited execute intent, generation checks, idempotent deploy/apply | Direct host shelling, arbitrary file writes, unbounded network fetch |
| Registry | Tenants, manifest versioning, control receipts, per-tenant config digests | Token material, secrets, shared tenant data |
| Tenant workload | Hosted runtime, queues, D1, bindings inside tenant account | Central control credentials, other tenants’ data |

### 4.2 Threat model and acceptance attacks

- Tenant A’s deploy token cannot access Tenant B or central infrastructure.
- Compromised tenant Worker cannot call central admin APIs.
- Health-check endpoint cannot be SSRF pivot.
- Stale/rolled back deploy cannot overwrite newer tenant generation.
- Token revocation halts future control actions quickly and visibly.
- Registry stores zero credentials at rest.

### 4.2 Attack vectors

| Vector | Failure mode | Control |
|---|---|---|
| Credential misuse | Root token left standing | Bootstrap-only mint, TTL, immediate revoke, IP/host narrowing |
| Tenant isolation breach | Shared metadata used as transport | Tenant metadata keyed by tenant manifest reference only |
| Spoofed telemetry | Fake heartbeat/reconcile status | Signed payloads, nonce/epoch monotonic checks |
| Build artifact drift | Unsigned artifacts | Digest lock + manifest hash + generation checks |
| Callback tampering | Untrusted postback path | Replay window, callback signature, tenant-scoped routing |
| SSRF | Unbounded health target input | Whitelist, scheme/path lock, no arbitrary fetch |
| Central compromise | Registry leak becomes cloud-wide | Capability partition: metadata-only registry vs deploy tokens |

## 5. Per-product Cloudflare capability matrix (Phase 0 minimums)

| Product/Service | Read | Write | Why needed in phase 0 | Phase 0 control posture |
|---|---|---|---|---|
| Workers Scripts + KV/ROUTES | `workers:read` + `workers:write` equivalent read APIs | deploy script and environment metadata | Deploy and reconcile tenant Worker artifact | Signed, tenant-owned scoped token; JIT escalation only where required |
| D1 | schema/read/list queries | table writes/DDL in tenant DB | Registry health + receipts + tenant task metadata | Tenant token only; no shared DB operations from central |
| Queues | `queues:read` | `queues:write` for pinned reconciliation control tasks | Backlog + lease + retry telemetry | Read-first; write only for control-control messages |
| Durable Objects | `workers_durable_objects:read` | `workers_durable_objects:write` | Host reconcile state + lock coordination | Tenant-only or delegated admin scope |
| R2/KV | object/metadata read | object/version write for artifacts | Receipts, logs, and cache snapshots as needed | Avoid tenant secrets and PII in central copies |
| Workers Logs / Logpush / OTEL | read/export via approved paths | no standing writes | Tenant support and auditability | Tenant-approved JIT support flow |
| Workflows | `workflows:read` | `workflows:write` | Durable reconcile jobs and status probes | Explicit per-tenant job namespace |
| API Tokens | read/ref checks | issue scoped child token | Onboard bootstrap and emergency support (phase 2+) | Hard-cap + short TTL + immediate revoke |

## 6. Evidence and test requirement for this ADR

**Required gating evidence before merge to main (this phase):**

1. Pilot execution against a non-shared Cloudflare account (not `e39eaf94…` shared mumega account)
2. Signed control-plane reconciler operation proof on that account
3. Matrixed check that read/write privileges match the minimal table above
4. Logged proof that no credential material is written to registry rows

Current status in this branch: design and matrix are documented; actual separate-account execution
receipt is still pending explicit credentials/governance sign-off.

## 7. Phase map

- **Phase 0** — ADR + threat model + capability matrix + separate account test proof (this item).
- **Phase 1** — read-only registry + signed attestation + health/drift.
- **Phase 2** — idempotent fenced reconciler; no dashboard shell-out.
- **Phase 3** — minimized push telemetry.
- **Phase 4** — tenant-approved JIT support.

## 8. Open, non-blocking calls

- If a tenant choice is blocked by policy, open a GitHub issue on the specific decision and
  continue other phases.
