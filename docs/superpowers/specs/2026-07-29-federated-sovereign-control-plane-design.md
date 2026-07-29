# Federated Sovereign Control Plane — design + handoff

Status: Phase 0 (ADR/threat-model/capability-matrix), not started.
Owner: unassigned — delegated to codex + cursor, 2026-07-29. Hadi away until Sunday; proceed
autonomously within existing gate rules (dyad-gate on sensitive surfaces, branch+PR only, no
direct deploy/merge without a GREEN gate).

## 1. Journey (how we got here, 2026-07-29 session)

1. Cleaned up stale Cloudflare Zero Trust Access apps on the mumega CF account
   (`e39eaf94…`): deleted `Digid (staging)`, `Viamar (staging)`, `Customer Dashboard`
   (`*.mumega.com/dashboard*` — was overprovisioned: single policy, Include=Everyone,
   Require=none, only IdP=One-Time-PIN, 168h session), and `Mumega Dashboard`
   (`app.mumega.com`, already dead — DNS wasn't even CF-proxied). Kept `Warp Login App` +
   `Google Drive` SAML (internal tooling, different category). End state: **no CF Access app
   protects any mumega.com hostname anymore, including `mupot.mumega.com` itself** — mupot's
   own app-level login is the only gate now. Full record: memory
   `project_cf_zero_trust_access_apps_pruned_to_mupot_only`.
2. Verified `digid.mumega.com` / `viamar.mumega.com` still resolve live (same CF edge IPs as
   `mupot.mumega.com`) — turned out to be public Inkwell marketing content (`noindex`,
   canonical to `digid.ca`/`viamar.ca`), served multi-tenant off ONE shared Worker via
   `x-tenant: <slug>` header routing. That's the **content layer** (Inkwell), separate from
   the **ops layer** (mupot) this doc is about.
3. Stopped `dashboard.service` on the host (`ubuntu-16gb-ash-1`) — a legacy
   `python3 -m sos.services.dashboard` process on `:8090`, proxied by the `app.mumega.com`
   nginx vhost. Confirmed via source read (`sos/services/dashboard/routes/`: brain, bus,
   customer, health, login, marketplace, sos_mesh, sos_operator, traces) that it has **zero
   mupot-related code** — pre-mupot SOS-bus tooling, safe to retire. Left the rest of that
   nginx vhost alone: `/auth`,`/signup` (:8075, also reachable via mumega.com's own vhost),
   `/webhook/viamar` (:6076, live Dialogflow webhook, no other exposure path found),
   `/.well-known/agent.json` + `/api/v1/tasks` (:6075, A2A agent discovery) — none of those
   were touched.
4. Hadi's ask: manage tenants FROM `mupot.mumega.com` (single pane of glass), but each
   tenant's actual compute/data lives in **their own Cloudflare account**, deployed via their
   own wrangler config — not shared multi-tenant DB, not fully separate unmanaged silos.
5. Found the current real state: mupot is single-tenant-per-deploy (no `tenants` table,
   `TENANT_SLUG` hardcoded, ~38 files coupled — 2026-06-19 decision). In practice `digid` and
   `viamar` deploy tokens both point at **our shared CF account** — no tenant has ever
   actually had a separate CF account. The broker-token mechanism (mint a scoped child token
   into a tenant's account) shipped 2026-06-06 for digid but was never pointed at a real
   separate account.
6. Sent the case to codex1 (bus, not CLI — keeps Hadi's visibility per standing rule) for a
   studied opinion. Full exchange below.

## 2. Codex's studied opinion (verbatim synthesis, 2026-07-29 22:06-22:07 UTC)

**Verdict: direction right, initial design wrong.** A thin central registry (metadata only)
is appropriate, but "registry + health-check + redeploy button" is **inventory, not a control
plane**. Two structural flaws in the original proposal:

1. A **persistent `Account API Tokens:Edit` broker** sitting in our infra is a token-minting
   root — too powerful to hold long-term.
2. A **dashboard action that shells directly into tenant-specific Wrangler state** — no
   separation between "decide" and "execute."

### Credentials
Preferred onboarding: the tenant's own Super Admin creates the deploy token directly (prefilled
Cloudflare token-template URL, scoped to that one account + exact products) — not us minting
it. Three separate capabilities, never one omnibus token: **deploy-write**, **observe-read**,
**break-glass/JIT-support**. Registry D1 stores only secret-store *references*, never the token
itself. If auto-minting is unavoidable, the broker token must be bootstrap-only: no other
permissions, IP-restricted + short TTL, used in an isolated job, then revoked immediately after
minting the scoped child. **IP-lock alone is not sufficient against host compromise/SSRF** —
Cloudflare's own docs warn an Account-API-Tokens:Edit token can mint tokens across all
authorized resources.

### Operations
Health+redeploy is insufficient. Cloudflare exposes real per-product APIs (D1 REST needs
D1 Read/Write; Queues exposes list/consumer/backlog metrics; Workers Logs stay in each
account while Tail Workers/OTEL/Logpush can push telemetry centrally) — needs an explicit
**per-product capability matrix**, not one blanket scope. Central dashboard should default to
**metadata only**: desired-vs-observed release digest, config-hash drift, last reconciliation,
health, queue aggregates, cost/limit signals. Full logs / D1 business-data queries must be
**tenant-approved JIT support, not standing access** — otherwise "the control plane silently
defeats data sovereignty." Central telemetry itself needs minimizing/redaction since logs can
carry tenant data.

### Blast radius + adjacent systems
A leaked child deploy token should mutate only that tenant's granted resources, with **zero
credential accepted by central admin APIs**. Indirect paths to guard: SSRF via
attacker-controlled health-check URL, forged callbacks/heartbeats, poisoned logs, malicious
build artifacts, tenant code receiving central secrets. Mitigations: canonical validated
endpoints, signed replay-protected telemetry, build-once signed artifact digests, no central
secret ever in tenant env, isolated per-tenant deploy runner. Registry leak → metadata/refs
only; vault/control-plane compromise → fleet-wide — **keep those two blast radii separated by
design**.

- **BYOA (runtime-adapter/v1) is adjacent, not duplicate:** this infra adapter provisions and
  returns a runtime manifest; BYOA governs the agent harness running on that substrate. Share
  only identity/capability/receipt contracts between them.
- **Workers for Platforms (dispatch namespaces) does NOT satisfy tenant-account sovereignty**
  — platform-owned account/billing/resources. Ruled out as a substitute for true separate CF
  accounts.

### Recommended epic shape — "Federated Sovereign Control Plane"

- **Phase 0** — ADR + threat model + capability matrix, **tested against a genuinely separate
  CF account** (flags explicitly: the current digid proof never actually tested that
  boundary — confirmed true in our own investigation above).
- **Phase 1** — read-only registry, signed attestation, health/drift.
- **Phase 2** — idempotent fenced reconciler deploys one pinned artifact + D1 via a direct
  scoped account token; **no dashboard shell-out, no arbitrary config path**.
- **Phase 3** — minimized push telemetry.
- **Phase 4** — tenant-approved JIT support.

### Acceptance attacks (must all hold before ship)
- Tenant-A's token cannot touch tenant-B or central.
- A compromised tenant Worker cannot call admin APIs.
- The health-check target cannot be used for SSRF.
- A stale deploy cannot overwrite a newer generation.
- Token revocation halts reconciliation immediately.
- The registry contains zero credentials, ever.

### Sources cited
- https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/
- https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/
- https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/
- https://developers.cloudflare.com/workers/observability/logs/tail-workers/

## 3. What's already proven vs what's new work

**Already proven (reuse, don't rebuild):**
- Broker-token → scoped-child-token minting chain (`~/.sos/keys/`, digid ledger entry
  2026-06-06) — needs redirecting at a REAL separate CF account for the first time, and
  needs the bootstrap-only/short-TTL/revoke-after-mint tightening codex specified.
- Signed-attach pattern (`fleet_agents`, Ed25519, no bearer token) — same shape needed for
  signed operational telemetry in Phase 3.
- `agents/<tenant>/mupot-<tenant>.wrangler.toml` per-tenant config file pattern — already
  stubbed, extend for the reconciler in Phase 2.

**New work (the actual epic):**
- `tenants` registry table + migration (Phase 1) — metadata/refs only, per codex's schema
  guidance above, not the full multi-tenancy data refactor that was rejected earlier.
- The reconciler service itself (Phase 2) — replaces the "dashboard shell-out" idea entirely.
- Per-product capability matrix definition (Phase 0 deliverable).
- Tenant-side onboarding flow: prefilled CF token-template URL, not us minting by default.
- JIT support flow (Phase 4).

## 4. Delegation

Hadi is away from Claude Code until Sunday. This doc is the full context handoff — no need to
re-derive anything above, it's grounded (CF API calls made live 2026-07-29, not guessed).

- **codex**: owns Phase 0 (ADR + threat model + capability matrix) — you wrote the opinion
  this phase is built from, you're best positioned to draft it. Open a design doc PR against
  this file's directory, then the GitHub issues for Phases 1-4 once Phase 0 is reviewed.
- **cursor**: available for parallel-track implementation once Phase 0 lands — Phase 1
  (registry table + migration) is the natural first build slice, low-risk, additive-only
  schema per the "no tenants table" lesson from the earlier rejected design.
- **Standing rules apply unchanged while Hadi is away:** branch + PR only, never merge to
  main without dyad-gate GREEN, no deploy, no minting of real broker tokens against any
  tenant's actual CF account without Hadi's direct go (this touches the four canonical
  sensitive surfaces — external-facing + credential-mint — adversarial gate runs in
  parallel with correctness gate, not after).
- If genuinely blocked on a decision only Hadi can make (e.g. which tenant gets the first
  real separate-CF-account pilot), file it as a tracked GitHub issue with the decision
  clearly framed, don't block the rest of the epic on it.
