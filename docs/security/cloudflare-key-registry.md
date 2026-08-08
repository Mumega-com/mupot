# Cloudflare key registry

What Cloudflare credentials exist, what each is for, and the **minimum** scope each
consumer actually needs. Members can read this without holding any credential.

Policy lives in [ROADMAP.md](../../ROADMAP.md#cloudflare-credential-governance-policy-effective-2026-08-07):
one token per named consumer, minimum permission groups, resource-scoped, expiring.

> Account: `e39eaf94f33092c4efd029d94ae1e9dd` (Admin@digid.ca). Zones are named
> explicitly — **never** grant "all zones".

## Before you verify anything, read this

Two failure modes both look like "your credential is bad." Both cost real time on
2026-08-07.

1. **Account-owned tokens FAIL `/user/tokens/verify`** with a flat `Invalid API Token`,
   which is indistinguishable from revoked. Use:
   ```bash
   curl -4 -H "Authorization: Bearer $T" \
     https://api.cloudflare.com/client/v4/accounts/<account_id>/tokens/verify
   ```
   A **known-good** token also returning "Invalid" is the tell that the endpoint is
   wrong, not the token.
2. **Always `curl -4`.** This host is dual-stack. Happy-eyeballs picks an address family
   per connection, so an IPv4-locked token fails **intermittently** — and on most
   endpoints it surfaces as `401 Authentication error`, not as a location error. Only
   `/zones` reports the real reason:
   `Cannot use the access token from location: 2a01:4ff:f0:8693::1`.
3. A **`429` during a capability sweep is not a capability answer.** Cloudflare
   rate-limits after repeated *auth* failures (`Too many authentication failures`), so a
   probe loop failing for one reason manufactures a second that hides the first. Space
   the probes and re-run before believing any row.

## Consumers and their minimum scope

Ranked by blast radius. This table is what replacement tokens are minted from.

| # | Consumer | Where | Live? | Minimum permission groups | Resource scope |
|---|---|---|---|---|---|
| 1 | **Tenant CF-token minting** | `sos-addons/services/billing/provision.py:53-99`, fires on Stripe webhook | ✅ `sos-saas.service` | `Account API Tokens:Write` | account only |
| 2 | **MCP-token auth fallback** | `SOS/sos/mcp/sos_mcp_sse.py:1290-1337` | ✅ `sos-mcp-sse.service` | `Workers KV Storage:Read` | `SOS_TOKENS` namespace |
| 3 | **Custom domain + KV provisioning** | `sos-addons/services/saas/domains.py:38-128`, `builder.py:270-283` | ✅ `sos-saas.service` | `Zone SSL and Certificates:Edit`, `Workers KV Storage:Edit`, `Account Settings:Read` | zone `mumega.com`; the two named KV namespaces |
| 4 | **Workers/Pages deploy (5 workers)** | 5 `.github/workflows/*.yml` + `npm run deploy` | ⚠️ see note | `Workers Scripts:Edit`, `Workers Routes:Edit`, `D1:Edit`, `Workers KV Storage:Edit`, `Cloudflare Pages:Edit`, `Account Settings:Read` | account + zone `mumega.com` |
| 5 | **R2 audit-anchor WORM** | `SOS/sos/jobs/audit_anchor.py` | ✅ timers, ~15 min | R2 *Object Read & Write* (HMAC, not a bearer token) | bucket `sos-audit-worm` only |
| 6 | **qNFT image upload** | `sos-addons/services/billing/qnft_image.py` | ✅ (service live) | R2 *Object Read & Write* | bucket `mumega-qnft` only |
| 7 | **Mirror → R2 Postgres backup** | `scripts/backup-mirror-db.sh` | ⚠️ **both schedulers `failed`** | `Workers R2 Storage:Edit` | bucket `mumega-backups` only |
| 8 | **Bus-token → KV push** | `sync-tokens-to-kv.py` | manual only | `Workers KV Storage:Edit` | `SOS_TOKENS` namespace |
| 9 | **Substrate health probe** | `scripts/substrate-health.mjs:279-285` | ✅ ~5 min timer | `Account Settings:Read` | account |
| 10 | **Workers AI health ping** | `factory_watchdog.py` | ✅ `factory-watchdog.service` | `Workers AI:Read` | account |
| 11 | **mupot tenant provisioning** | `mupot/plugin/tools.py` | transient export | `Workers Scripts:Edit`, `D1:Edit`, `Workers KV Storage:Edit`, `Account Settings:Read` | account (multi-tenant by nature) |
| 12 | **Shabrang Astro Pages deploy** | `Mumega-com/shabrang/.github/workflows/deploy.yml:L23-27` | ⏳ pending token swap | `Cloudflare Pages:Edit`, `Account Settings:Read` | account + zone `mumega.com` |

### Notes on individual rows

**#1 is the highest-privilege consumer on the host and cannot be narrowed.** Cloudflare
exposes token-minting only as `Account API Tokens:Write` — there is no "may mint only
D1-scoped sub-tokens" permission. What *can* be fixed is over-scope: this consumer
currently rides a token with ~130 permission groups, while the code uses
`Account API Tokens:Write` plus the two D1 permission IDs it hardcodes. Everything else
is unused privilege on a path that fires from an external webhook.

**#4 — `gh secret list` returned empty.** That is **not** evidence the GitHub Actions
secrets are gone; it is most likely an insufficient token scope. Re-check with an
org-admin `gh` session before concluding anything.

**#7 has two schedulers for one job.** `mirror-backup.service`/`.timer` (**user** scope,
daily) and `r2-backup.service`/`.timer` (**system** scope, weekly) drive the identical
script against the identical bucket, and **both currently report `failed`**. Check both
systemd scopes — a system-scope unit is invisible to `systemctl --user` and reads like
"it doesn't exist."

**#11 — the docs are stale and dangerous.** `mupot/plugin/skills/mupot-operator/SKILL.md:118`
claims `MUPOT_CF_API_TOKEN` "lives in Hermes `.env.secrets` in plaintext." It is
**not** persisted anywhere on the host; the live pattern is a transient per-command
export from a token file, which is the safer one. Fix the doc line before someone
"fixes" reality to match it.

**#12 — SHABRANG BUILD TOKEN (INCIDENT, IN PROGRESS).** User-owned token on dashboard
(`https://dash.cloudflare.com/profile/api-tokens`), found 2026-08-07. **Consumer identified:**
`Mumega-com/shabrang` repository, `.github/workflows/deploy.yml`, Astro site deploy to
Cloudflare Pages (`mumega-inkwell` project). **Old token state:** 26 permission groups
including `Account.Secrets Store` (read secrets — dangerous); `All zones` (should be 1 zone);
no expiry (should be 90d).

**Replacement plan (task f16dfac1):** (1) Mint scoped token with `Cloudflare Pages:Edit` +
`Account Settings:Read`, zone `mumega.com` only, 90-day expiry; (2) Update GitHub Actions
secret in Shabrang repo; (3) Run deploy workflow to verify new token works; (4) Delete old
token from dashboard. See `docs/security/shabrang-token-replacement.md` for detailed steps.

**Blocker:** Permission ID for "Cloudflare Pages:Edit" must be discovered from Cloudflare API.
NEW token can then be minted by Kasra or admin token holder.

## Credentials with no consumer — revoke candidates

Confirmed present and injected into ~50 systemd services via `EnvironmentFile`, with
**no code consumer found anywhere**:

- `CF_ZEROTRUST_TOKEN`
- `CF_DNS_TOKEN`
- `~/.sos/keys/cf-codex-workers-read.token` — **expired 2026-06-06**
- `~/.fleet/agents/cf-ops.token` — no consumer found; scope UNSURE

Account-side tokens not yet tied to a consumer: `Prefrontal` (2026-03-03),
`Workers AI` (2026-01-12), `agentlink-d1`, `small-union-7840`. **Do not revoke on
absence of evidence** — several are plausibly tenant- or CI-side and live off this host.
Identify first.

## Account state at policy time (2026-08-07)

**16 active account-owned tokens. 13 never expire. 3 can mint tokens** — `kasra`,
`kasra-apig`, `kasra-db-tenant`. The token believed retired in the 2026-07-29 sweep
(`kasra`, issued 2026-05-30, ~130 permission groups, `expires_on: None`) verifies
**active**.

A surviving credential that can mint credentials makes a revocation sweep retroactively
meaningless. All three mint-capable tokens must be addressed together or none of them is.

Confirmed clear: no stale `CLOUDFLARE_API_TOKEN` in `~/.bashrc` or `~/.profile`.

## Order of operations — never revoke first

```
inventory consumers → mint scoped replacements → cut over → verify → THEN revoke
```

Killing a credential that a CI workflow or a running agent depends on fails **silently**
and gets found later by a human noticing something stopped.

⚠️ **Blocked on mupot#764.** Several consumers above read from `~/.env.secrets`, whose
contents are currently exposed in plaintext across AI-CLI session transcripts. Rotating
Cloudflare credentials *into* that file would immediately re-leak them. The capture
mechanism gets fixed first.
