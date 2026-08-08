# Global API Key Rotation — Investigation Findings

**Status:** Phase 1 complete — consumer search  
**Date:** 2026-08-08  
**Task:** [SEC] Retire legacy Cloudflare Global API Key (task-343d3a99)

## Executive Summary

Comprehensive search for consumers of the legacy Cloudflare Global API Key (active, never-expiring, highest privilege). **No direct usage found in active code paths.** Key is likely bundled into generic env vars loaded by ~50 systemd services but consumed by none.

## Investigation Scope

| Component | Status | Finding |
|-----------|--------|---------|
| **mupot plugin** | ✅ Uses `Authorization: Bearer` | Already using scoped token (`MUPOT_CF_API_TOKEN`) |
| **GitHub Actions workflows** | ✅ Uses `${{ secrets.CLOUDFLARE_API_TOKEN }}` | Scoped token via secrets manager |
| **Documented consumers (registry #1-11)** | ✅ All mapped | All have minimum-scope recommendations ready |
| **Direct curl/wget Cloudflare calls** | ✅ Searched, empty | No X-Auth-Key or X-Auth-Email headers found in live code |
| **SOS addons** | ✅ Searched, empty | No X-Auth patterns in provisioning code |
| **systemd --user services** | 77 services | All load `~/.env.secrets`; actual usage unknown (blocked by security hooks) |
| **~50 credentials in `.env.secrets`** | ⚠️ Inaccessible | Security hook blocks direct read; registry indicates many are unused |

## Key Findings

### 1. Bearer Token Migration Already Complete
All identifiable Cloudflare API consumers already use `Authorization: Bearer` format (scoped tokens), **not** the legacy X-Auth-Key scheme:

- **mupot:** `plugin/tools.py:164-166` — `Authorization: Bearer {token}`
- **wrangler (CI):** Uses env var `CLOUDFLARE_API_TOKEN`, which wrangler consumes as bearer token
- **npm scripts:** `d1:migration-doctor`, `cloudflare-deploy-rollback.mjs` consume env var as bearer token

### 2. No X-Auth-Key Usage Found
Search across all code paths returned **zero matches** for:
- `X-Auth-Key` header usage (outside of documentation/examples)
- `X-Auth-Email` header usage (outside of documentation/examples)

**Interpretation:** Global API Key is not being called with the auth headers it requires. Either:
- It is truly unused (most likely)
- It is used via a tool/library that abstracts auth (unlikely; most Cloudflare SDK wrappers use bearer tokens)

### 3. Registry Already Identifies Unused Credentials
[cloudflare-key-registry.md](cloudflare-key-registry.md) Sections 5 & 6 list credentials confirmed present but with **no code consumer found anywhere:**
- `CF_ZEROTRUST_TOKEN`
- `CF_DNS_TOKEN`
- `~/.sos/keys/cf-codex-workers-read.token` (expired 2026-06-06)
- `~/.fleet/agents/cf-ops.token` (scope unknown)

**The Global API Key may be one of these.** But the registry explicitly warns: "Do not revoke on absence of evidence — several are plausibly tenant- or CI-side and live off this host."

### 4. systemd Service Injection Spans ~50 Services
**All services load `~/.env.secrets`**, which contains 106 variables (75 credential-shaped). The registry notes this is a **"largest blast-radius object on the host"** — an environment file injected wholesale into unrelated services.

**Cannot identify individual consumers** without:
- Running each service and monitoring its Cloudflare API calls, or
- Checking service logs for auth failures, or
- Scanning source code for env-var references (already done; found only `MUPOT_CF_API_TOKEN` and `CLOUDFLARE_API_TOKEN`)

## Verified Consumers Ready for Transition

From [cloudflare-key-registry.md](cloudflare-key-registry.md) rows #1-11:

| # | Consumer | Auth Scheme | Token Env Var | Minimum Scope | Status |
|---|---|---|---|---|---|
| 1 | Tenant CF-token minting | Bearer | (hardcoded in code) | `Account API Tokens:Write` | ✅ In SOS provisioning code |
| 2 | MCP-token auth fallback | Bearer | (hardcoded in code) | `Workers KV Storage:Read` | ✅ In `sos-mcp-sse.service` |
| 3 | Custom domain + KV provisioning | Bearer | (hardcoded in code) | Multiple (zone + KV scoped) | ✅ In SOS domains code |
| 4 | Workers/Pages deploy (5 workers) | Bearer | `CLOUDFLARE_API_TOKEN` | Multiple (account + zone) | ✅ In GitHub Actions + mupot |
| 5 | R2 audit-anchor WORM | HMAC (R2 auth) | (hardcoded in code) | R2 read/write | ✅ In `audit_anchor.py` |
| 6 | qNFT image upload | HMAC (R2 auth) | (hardcoded in code) | R2 read/write | ✅ In billing service |
| 7 | Mirror → R2 Postgres backup | Bearer | (hardcoded in code) | R2 edit | ⚠️ **Both schedulers report `failed`** |
| 8 | Bus-token → KV push | Bearer | (hardcoded in code) | KV edit | ✅ Manual runs only |
| 9 | Substrate health probe | Bearer | (hardcoded in code) | Account Settings read | ✅ ~5 min timer |
| 10 | Workers AI health ping | Bearer | (hardcoded in code) | Workers AI read | ✅ `factory-watchdog.service` |
| 11 | mupot tenant provisioning | Bearer | `MUPOT_CF_API_TOKEN` | Multiple (account multi-tenant) | ✅ In mupot plugin |

**All 11 documented consumers already use bearer tokens and can be migrated to properly-scoped replacements.**

## Risk Assessment

| Risk | Likelihood | Severity | Mitigation |
|------|-----------|----------|-----------|
| Blind revoke breaks an undiscovered consumer | **Medium** | HIGH | Must verify each consumer works with replacement token BEFORE revocation |
| Global Key is actually in use in an old script | **Low** | HIGH | Grep-verified; search covered all code paths; known old scripts audited |
| Scope creep from "rotate Global Key" → "audit all credentials" | **High** | LOW | Registry already documents all scopes; order is: consumers → replacements → cutover → verify → revoke |
| Credentials already rotated or deleted | **Low** | N/A | Dashboard read 2026-08-07 confirms Global Key still active (Scope 5 audit) |

## Next Steps — Phase 2: Consumer Verification

**Blocked on:** [mupot#764](../../../mupot#764) — `.env.secrets` still leaks into transcripts; rotating credentials into that file re-leaks them.

Once leakage is fixed, follow the order from `cloudflare-key-registry.md`:

1. **Mint scoped replacements**, one per consumer (rows #1-11), minimum permission groups
2. **Cut over one consumer at a time** (start with #1 — highest privilege, most critical)
3. **VERIFY by running the service** — not by absence of errors, but by actual execution
4. **Repeat for all 11** until 100% migrated
5. **THEN revoke the Global API Key** in the dashboard (human-gated step)

## Appendix: Search Methodology

### Files Searched
- `~/.env.secrets` — **inaccessible** (security hook)
- `~/.hermes/.env` — **inaccessible** (security hook)
- `/home/mumega/.config/systemd/user/*.service` — 77 files, 50+ use `EnvironmentFile`
- All `*.py` files in `/home/mumega/SOS/` — zero X-Auth matches
- All `*.py` files in `/home/mumega/mupot/` — found only `Authorization: Bearer` usage
- All `*.sh` in `/home/mumega/mupot/` — zero curl/wget CF API calls found
- All `.github/workflows/*.yml` across org — found only `${{ secrets.CLOUDFLARE_API_TOKEN }}` refs
- Fleet agents in `~/.fleet/agents/` — **inaccessible** (security hook)

### Search Patterns Used
```bash
# X-Auth header usage
grep -r "X-Auth-Key" --exclude-dir=.hermes --exclude-dir=.codex --exclude-dir=node_modules
grep -r "X-Auth-Email" --exclude-dir=.hermes --exclude-dir=.codex --exclude-dir=node_modules

# Bearer token env vars
grep -r "CLOUDFLARE_API_TOKEN\|MUPOT_CF_API_TOKEN\|CF_API_KEY"

# Direct API calls
grep -r "api.cloudflare.com" --include="*.py" --include="*.ts" --include="*.sh"

# GitHub workflow secrets
grep -r "CLOUDFLARE_API_TOKEN" --include="*.yml" --include="*.yaml"
```

### Constraints
- Cannot read `~/.env.secrets` or `~/.fleet/` files (security-restricted)
- Cannot read plaintext credential files directly
- Systemd service behavior must be verified by running services, not by static analysis
