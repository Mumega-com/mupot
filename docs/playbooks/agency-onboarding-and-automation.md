# Agency pot onboarding — process + self-serve automation plan

> Goal (Hadi, 2026-06-19): stop hand-rolling each agency onboarding. Document the process
> once, then build the automation so a new agency is a **register link** Hadi sends — the
> pot stands itself up. First instance: Digital Marketing Experts (Maryam Golabgir) — a
> GTA agency (~10 SMB clients) adding/reselling AI **AEO** (Answer-Engine Optimization)
> alongside SEO/Ads/Content.

## 0) What an "agency pot" is
A mupot tenant whose service-delivery org is the reusable **`agency` department** (this PR):
squads **SEO · AEO · Paid Ads · Content**. Each squad runs governed loops (perceive client
signal → propose a change → human/envelope gate → apply → measure) over the **CRO data
fabric** (`src/cro/*`): per-client connectors (Google Search Console, Google Ads, WordPress,
PostHog) normalize into `cro_events` / `metric_points`, the loop acts, the cockpit steers.
The agency resells this as its SEO/AEO/Ads/Content service, one pot, many clients.

---

## 1) Manual onboarding process TODAY (what stands up Maryam's pot)
Tier from the playbook tree: **B — tenant on the shared mupot** (not CF-native product, no
bot endpoint, no AWS). Steps, in order, with the gate on each:

| # | Step | Who / gate |
|---|------|-----------|
| 1 | **Tenant row** — create the `tenants` row on the shared mupot (slug e.g. `dme`, name, status active). Playbook non-negotiable #1: D1 tenant row exists first. | Hadi-go (customer mint). Product path, never raw D1. |
| 2 | **Subdomain routing** — map `dme.mupot.mumega.com` (or her domain) to the worker; tenant resolves from the Host header (existing `tenantResolver`). | Hadi-go (CF route). |
| 3 | **Tier** — set the pot tier ≥ **pro** (the agency dept seeds 4 squads; free/starter's maxSquads < 4 → the S6 gate refuses). Via the HMAC billing route. | Hadi-go (billing). |
| 4 | **Activate the `agency` department** — seeds SEO/AEO/Ads/Content squads (idempotent). | Owner/admin (the provision flow). |
| 5 | **Owner-walk** — Maryam OAuth-logs-in to `/setup`, seeds her goal-bearing agent(s); the `*/15` metabolism then runs them. | **Maryam** (sovereignty — can't be bypassed). |
| 6 | **Per-client connectors** — for each client, connect GSC / Google Ads / WordPress / PostHog via the CRO connector vault (encrypted, per-tenant). | **Maryam / her clients** (their creds; never auto-seeded). |

**Lane discipline (the viamar lesson):** onboard the rails and STOP. Never study/manage her
agency, never raw-D1-seed clients' content, never import her clients' work as tasks.

---

## 2) The automation — the "register link" target
Replace steps 1–4 above (the hand-rolled mint) with a **self-serve flow** Hadi triggers by
sending one URL. Steps 5–6 stay human by design (owner OAuth + client creds).

### The flow
```
Hadi sends register link  ─►  /register (public page)
   agency submits: name, domain, contact email, plan
        │
        ▼
   [Hadi approve?]  ── optional gate: approve a new paying tenant
        │
        ▼
   provisionAgencyTenant():
     1. create tenants row (slug from domain)           ← product path
     2. provision subdomain route (CF API)              ← automate
     3. set tier (from chosen plan, ≥ pro)              ← billing route
     4. activate 'agency' department (seed 4 squads)    ← registry.activate (built)
     5. email owner a magic onboarding link             ← /setup owner-walk
        │
        ▼
   owner OAuth walk  ─►  seed agent(s)  ─►  connect clients  ─►  pot breathes
```

### Components — built vs to-build
| Component | State |
|---|---|
| Reusable `agency` department template (4 squads) | ✅ built (this PR) |
| `registry.activate()` (seed + idempotent + tier-gated) | ✅ built |
| Plan tiers + entitlement gate (maxSquads bites) | ✅ built (S6) |
| CRO connector vault (per-tenant, encrypted) + connector types (GSC/Ads/PostHog/CRM) | ✅ built (S4 vault + slice-1 types) |
| Owner-walk `/setup` wizard (seed goal-bearing agent) | ✅ built (#20) |
| Provision tools (create dept/squad/agent, mint token) | ✅ built |
| **Public `/register` page** (the link) | ⬜ to-build |
| **`provisionAgencyTenant()`** — orchestrates tenant row + subdomain + tier + activate | ⬜ to-build |
| **Subdomain auto-provision** (CF custom-hostname API) | ⬜ to-build |
| **Magic onboarding-link email** to the owner | ⬜ to-build |
| **Per-client connector wizard** (GSC/Ads/WP OAuth) | ⬜ to-build (largest; per-connector) |
| Optional **Hadi-approve-new-tenant** gate | ⬜ to-build (recommended for paid tenants) |

### Build slices (each dyad-gated)
1. **`provisionAgencyTenant()`** — the orchestrator (tenant row → tier → `activate('agency')`),
   behind an HMAC/admin gate. Idempotent, fail-closed, atomic-ish. *No subdomain/email yet —
   returns the pot + an owner-walk link.* This alone turns onboarding into one server call.
2. **Subdomain auto-provision** (CF custom-hostname API) + the magic-link email.
3. **Public `/register` page** → calls slice 1 (optionally behind Hadi-approve).
4. **Connector wizard** — GSC, then Google Ads, then WordPress, then PostHog (each its own
   OAuth/credential flow into the vault). The long tail; ships connector-by-connector.

### Human gates that NEVER automate (by design)
- **Owner OAuth walk** — the tenant's own login seeds their agents (sovereignty; agents can't self-grant owner).
- **Client credentials** — each client's GSC/Ads/WP creds come from the tenant, encrypted into the vault; never auto-seeded.
- **(recommended)** Hadi approves a new *paying* tenant before provision — money/identity boundary.

---

## 3) For Maryam right now
With this PR merged, her onboarding is steps 1–4 (Hadi-go mint + activate `agency`) → step 5
(her owner-walk) → step 6 (connect her first client's GSC/WP). The automation above makes the
*next* agency a link. Recommended first build: **slice 1 (`provisionAgencyTenant`)** — it
collapses the hand-rolled mint into one gated call and is the spine the register page sits on.
