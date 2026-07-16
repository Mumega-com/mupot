# Agency pot onboarding — process + self-serve automation plan

> Goal (Hadi, 2026-06-19; corrected to real architecture 2026-07-16): stop hand-rolling
> each agency onboarding. Document the *real* process once, then build the automation.
> First agencies: **Digital Marketing Experts** (Maryam Golabgir) — a GTA agency (~10 SMB
> clients) reselling AI **AEO** (Answer-Engine Optimization) alongside SEO/Ads/Content —
> and **Digid** (second agency).

> ⚠ **2026-07-16 correction.** An earlier version of this doc described a `tenants`-table +
> subdomain-Host-header + `tenantResolver` **shared-worker** model. That architecture does
> **not exist in code** (`grep tenantResolver src/` → 0 hits). The real, current model is
> **one Cloudflare Worker per tenant** — see `docs/SELF-HOST.md` (canonical) and
> `src/org/index.ts` ("this Worker's D1 IS the tenant's pot"). This doc is now aligned to it.

## 0) What an "agency pot" is
A mupot tenant whose service-delivery org is the reusable **`agency` department**: squads
**SEO · AEO · Paid Ads · Content**. Each squad runs governed loops (perceive client signal →
propose a change → human/envelope gate → apply → measure) over the **CRO data fabric**
(`src/cro/*`): per-client connectors (Google Search Console, Google Ads, WordPress, PostHog)
normalize into `cro_events` / `metric_points`, the loop acts, the cockpit steers. The agency
resells this as its SEO/AEO/Ads/Content service — **one pot = one Worker, many clients**.

---

## 1) Onboarding process TODAY — the REAL one-Worker-per-tenant flow

A pot is a single Worker (`wrangler.<pot>.toml`) with its own D1/Vectorize/Queues/KV/R2/DO
bindings. Provisioning is scripted and idempotent — **no `tenants` row, no shared worker, no
Host-header resolver.** Canonical reference: `docs/SELF-HOST.md`.

| # | Step | Command / who · gate |
|---|------|----------------------|
| 1 | **Provision the pot's infra** — create D1 + Vectorize + Queues + KV + R2, write `wrangler.<slug>.toml`, apply migrations. | `bash scripts/setup.sh --pot <slug>` (after `wrangler login`). Idempotent. |
| 2 | **Deploy the Worker.** | `wrangler deploy -c wrangler.<slug>.toml` |
| 3 | **Set secrets + bootstrap the owner.** OAuth creds, or `--bootstrap-owner` for a one-time owner token. | `bash scripts/secrets.sh --pot <slug>` · Hadi-go for a *hosted* tenant (secret write); a self-host fork does its own. |
| 4 | **Owner-walk** — the agency owner (Maryam) OAuth-logs-in to `/setup`; **first login becomes owner**, seeds her goal-bearing agent(s); the `*/15` metabolism then runs them. | **Maryam** (sovereignty — cannot be bypassed; agents can't self-grant owner). |
| 5 | **Activate the `agency` department** — seeds SEO/AEO/Ads/Content squads (idempotent, tier-gated: needs tier ≥ **pro**, else the S6 maxSquads gate refuses). | Owner/admin. |
| 6 | **Per-client connectors** — for each client, connect GSC / Google Ads / WordPress / PostHog via the CRO connector vault (encrypted, per-tenant/per-squad). | **Maryam / her clients** (their creds; never auto-seeded). |

For a **self-host fork** (agency on its own Cloudflare account), steps 1–3 are the whole
infra story and require no mumega hands — see `docs/SELF-HOST.md`. For a **hosted** tenant on
our account, steps 1 + 3 (resource create + secret write) are Hadi-go (customer mint / money
/ identity boundary).

**Lane discipline (the viamar lesson):** onboard the rails and STOP. Never study/manage her
agency, never raw-D1-seed clients' content, never import her clients' work as tasks.

---

## 2) The WordPress channel — reality (2026-07-16)

The agency value is gated agents acting on clients' WordPress. Two distinct things:

- **mumcp** — the standalone MCP WordPress product: **live on ~10 sites, WP-native, 250+
  tools** (pages, Elementor, SEO, media, …). This is the rich, proven surface.
- **mupot's internal `mcpwp` executor** (`src/departments/executors/mcpwp.ts`) — currently a
  **shallow bridge**: posts to bare `wp-json/wp/v2/posts`, **create-draft only**;
  update-by-slug is hard-refused (`collectors/seo-meta-fix.ts`, `mcpwp_unsupported`).

**Gap (#370):** wire mupot's channel through the real mumcp tool surface so gated agents get
the full WP capability, not just one draft post. This is the #1 product move for the agency
GTM — until it lands, "agents manage a client's WordPress via mupot" means create-draft only.

---

## 3) The automation — "register link" target (HONEST built-vs-planned)

The vision: a new agency is a **register link** Hadi sends; the pot stands itself up. Current
truth from the code:

| Component | State |
|---|---|
| Raw infra provisioners (`scripts/setup.sh`, `secrets.sh`, `provision-pot.sh`) | ✅ built, working, idempotent |
| Reusable `agency` department template (4 squads) | ✅ built |
| `registry.activate()` (seed + idempotent + tier-gated) | ✅ built |
| Plan tiers + entitlement gate (maxSquads) | ✅ built (S6) |
| CRO connector vault (per-tenant/per-squad, encrypted) | ✅ built (S4) |
| Owner-walk `/setup` wizard | ✅ built (#20) |
| **`provisionAgencyTenant()` orchestrator** | ⬜ **NOT built** — `src/reseller/provision.ts` is a **dry-run planner only** (its own header: "performs NO I/O… the EXECUTE leg is deliberately NOT here"). |
| **Public `/register` page** | ⬜ NOT built |
| **Full WordPress tool surface behind the channel** (#370) | ⬜ NOT built (see §2) |
| **Per-client connector wizard** (GSC/Ads/WP OAuth) | ⬜ NOT built (largest; per-connector) |

### Build slices (each dyad-gated)
1. **Wire `mcpwp` → real mumcp** (#370) — the actual product gap; unblocks agency value.
2. **`provisionAgencyTenant()` execute leg** — turn the dry-run planner into a real
   orchestrator behind an HMAC/admin gate. Idempotent, fail-closed. Returns the pot + an
   owner-walk link. (No subdomain/email yet.)
3. **Public `/register` page** → calls slice 2 (optionally behind a Hadi-approve gate).
4. **Connector wizard** — GSC → Google Ads → WordPress → PostHog, each its own OAuth flow
   into the vault. The long tail; ships connector-by-connector.

---

## 4) Human gates that NEVER automate (by design)
- **Owner OAuth walk** — the tenant's own login seeds their agents (sovereignty).
- **Client credentials** — each client's GSC/Ads/WP creds come from the tenant, encrypted
  into the vault; never auto-seeded.
- **Hadi approves a new *paying* / *hosted* tenant** before provision — money/identity boundary.

---

## 5) For DME (Maryam) + Digid right now
Onboarding today = steps 1–3 (provision infra: `setup.sh` → deploy → `secrets.sh`, Hadi-go on
a hosted pot) → step 4 (her owner-walk) → step 5 (activate `agency`) → step 6 (connect her
first client's GSC/WP). The biggest lever to make the pot actually *deliver* for her clients
is **§2/#370 — wire the real mumcp WordPress surface**; the register-link automation (§3)
makes the *next* agency a link, but the WP-channel depth is what the agency sells.
