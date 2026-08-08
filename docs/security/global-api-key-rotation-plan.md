# Global API Key Rotation — Execution Plan

**Status:** Ready for Phase 2 (blocked on mupot#764)  
**Task:** [SEC] Retire legacy Cloudflare Global API Key  
**Order:** consumers → mint → cutover → verify → revoke

---

## Phase 1: Identify Consumers ✅

**Complete.** See [global-api-key-rotation-findings.md](global-api-key-rotation-findings.md).

11 documented consumers identified from `cloudflare-key-registry.md` rows #1-11.  
No unknown consumers found via code search.  
All 11 already use `Authorization: Bearer` format (not X-Auth-Key).

---

## Phase 2: Mint Scoped Replacements ⏳

**Blocked:** mupot#764 (`.env.secrets` leakage into transcripts).  
**When unblocked:** Mint tokens via Cloudflare API using the account-admin `kasra` token.

### Minting Template (per consumer)

```bash
# Example: Consumer #1 (Tenant CF-token minting)
# Minimum scope: Account API Tokens:Write
# Resource scope: account only (no zone)
# Expiry: 90 days from mint date

curl -4 -X POST https://api.cloudflare.com/client/v4/user/tokens \
  -H "Authorization: Bearer $KASRA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "sos-saas-provision-token-20260808",
    "description": "Tenant CF-token minting from Stripe webhook",
    "policies": [
      {
        "effect": "allow",
        "permission_groups": [
          {
            "id": "<Account API Tokens:Write permission ID>"
          }
        ],
        "resources": {
          "com.cloudflare.api/account/~": "<account_id>"
        }
      }
    ],
    "not_before": "2026-08-08T00:00:00Z",
    "expires_on": "2026-11-06T23:59:59Z"
  }'
```

### Consumers to Mint (in order of blast radius)

Rank by **blast radius** (high → low). Start with highest-privilege consumers.

| Rank | Consumer | Service | Minimum Permissions | Resource Scope | Expires | Status |
|------|----------|---------|---------------------|-----------------|---------|--------|
| 1 | Tenant CF-token minting | `sos-saas.service` | `Account API Tokens:Write` | account | 2026-11-06 | ⏳ To mint |
| 2 | MCP-token auth fallback | `sos-mcp-sse.service` | `Workers KV Storage:Read` | namespace: `SOS_TOKENS` | 2026-11-06 | ⏳ To mint |
| 3 | Custom domain + KV provisioning | `sos-saas.service` | Zone SSL, KV Edit, Account Settings Read | zone: `mumega.com`; KV namespaces | 2026-11-06 | ⏳ To mint |
| 4a | Workers deploy (ink-api) | CI: `deploy-inkwell-api.yml` | Workers Scripts, Routes, D1, KV, Pages Edit | account + zone: `mumega.com` | 2026-11-06 | ⏳ To mint |
| 4b | Workers deploy (provisioning) | CI: `deploy.yml` (provisioning job) | Same as 4a | Same as 4a | 2026-11-06 | ⏳ To mint |
| 4c | Pages deploy | CI: `deploy.yml` (pages deploy) | Same as 4a | Same as 4a | 2026-11-06 | ⏳ To mint |
| 5 | R2 audit-anchor (WORM) | `audit-anchor.service` | R2 Object Read & Write (HMAC) | bucket: `sos-audit-worm` | 2027-02-03 | ⏳ To mint |
| 6 | qNFT image upload | `qnft-marketplace-bridge.service` | R2 Object Read & Write (HMAC) | bucket: `mumega-qnft` | 2027-02-03 | ⏳ To mint |
| 7 | Mirror → R2 backup | `mirror-backup.service` | Workers R2 Storage:Edit | bucket: `mumega-backups` | 2026-11-06 | ⏳ To mint |
| 8 | Bus-token → KV push | manual invocation | Workers KV Storage:Edit | namespace: `SOS_TOKENS` | 2026-11-06 | ⏳ To mint |
| 9 | Substrate health probe | ~5 min timer | Account Settings:Read | account | 2026-11-06 | ⏳ To mint |
| 10 | Workers AI health ping | `factory-watchdog.service` | Workers AI:Read | account | 2026-11-06 | ⏳ To mint |
| 11 | mupot tenant provisioning | `mupot` CLI export | Workers Scripts Edit, D1 Edit, KV Edit | account (multi-tenant) | 2026-11-06 | ⏳ To mint |

---

## Phase 3: Cut Over ⏳

**Order:** One consumer at a time. Start with #1.

**For each consumer:**

1. **Prepare:** Write new scoped token to a private token file (mode 0600)
2. **Update:** Modify the service unit or script to read the new token file instead of the env var
3. **Test (dry-run first):** Run the service/script with the new token in a safe context (not production)
4. **Deploy:** Swap the token file into production
5. **Verify:** Run the service/script in production; capture logs; confirm success
6. **Document:** Record token ID, expiry, and cutover date in this file

### Template: Consumer #N Cutover

**Target:** [Consumer name]  
**Service:** [systemd unit / GitHub Action / CLI]  
**Status:** ⏳

**Step 1: Mint token**
```bash
# Token ID: <will fill after mint>
# Token value: <will store in ~/.sos/keys/consumer-N-token>
# Expiry: YYYY-MM-DD
```

**Step 2: Validate token works**
```bash
# Test endpoint (from registry notes or code)
# E.g. for Account API Tokens:Write, test: GET /accounts/{id}/tokens/verify
curl -4 -H "Authorization: Bearer $TOKEN" \
  https://api.cloudflare.com/client/v4/accounts/e39eaf94f33092c4efd029d94ae1e9dd/tokens/verify

# Response should be: {"success": true, ...}
```

**Step 3: Update service unit**
```bash
# Modify .service file:
# OLD: EnvironmentFile=/home/mumega/.env.secrets
# NEW: ExecStartPre=/bin/sh -c 'export CONSUMER_TOKEN=$(cat ~/.sos/keys/consumer-N-token)'
# Then: ExecStart= ... $CONSUMER_TOKEN
```

**Step 4: Dry-run**
```bash
systemctl --user start consumer-N-service --dry-run
# OR
export CONSUMER_TOKEN=$(cat ~/.sos/keys/consumer-N-token)
/path/to/script.sh  # with logging enabled
```

**Step 5: Deploy + Verify**
```bash
# Swap token file to production
# Run the service for real
# Check logs for success
# Confirm the Cloudflare API calls succeeded
```

**Step 6: Document**
- Token ID: (from mint response)
- Expiry: 2026-11-06
- Cutover date: 2026-08-??
- Verified: ✅ / ❌
- Notes: [any issues encountered]

---

## Phase 4: Verify Each Consumer ⏳

**Do not consider a consumer "migrated" until it has been run with the new token.**

For each consumer, after cutover:

1. **Run the service** (or invoke the script)
2. **Monitor its Cloudflare API calls** (via logs, `strace`, or Cloudflare audit logs)
3. **Confirm it succeeded** (exit code 0, expected side effects occurred, no auth errors)
4. **Log the evidence** (timestamp, output, CF request/response hashes)

### Verification Evidence Checklist

- [ ] Service/script ran with new token and exited successfully
- [ ] No `401 Unauthorized`, `403 Forbidden`, or `404 Not Found` errors from CF API
- [ ] Expected Cloudflare side effect occurred (resource created, updated, or read)
- [ ] Logs show the auth header was sent (or at minimum, auth header is not in logs per security)
- [ ] Service did not fall back to the Global API Key (grep logs for old token refs)
- [ ] No permission-denied errors (e.g., "insufficient privileges")

### Consumers With Known Verification Strategies

| Consumer | How to Verify | Expected Outcome |
|----------|---------------|------------------|
| #1: Tenant minting | Trigger Stripe webhook for a new tenant | New D1+KV databases appear under the account |
| #2: MCP KV fallback | Issue a bus-token request | Token is read from / written to KV successfully |
| #3: Custom domains | Provision a new custom domain | New zone records and KV entries created |
| #4a-c: Workers deploy | Run the deploy workflow or `npm run deploy` | Worker+Pages+D1 migrations deployed without errors |
| #5: R2 audit-anchor | Run the timer or manually invoke | Audit entry written to R2 WORM bucket |
| #6: qNFT upload | Upload a test qNFT image | Image appears in R2 bucket |
| #7: Mirror backup | Run `mirror-backup.service` | Postgres dump uploaded to R2 |
| #8: Bus-token KV | Run `sync-tokens-to-kv.py` | Tokens written to KV namespace |
| #9: Health probe | Run the timer or manually invoke | Substrate health metrics recorded |
| #10: Workers AI ping | Run `factory-watchdog.service` | Health check completes, no 401s in logs |
| #11: mupot provisioning | Run `mupot provision-tenant` with a test tenant | D1 + KV provisioned for the tenant |

---

## Phase 5: Revoke the Global API Key 🔴

**When:** Only after all 11 consumers are verified working with replacement tokens.  
**Who:** Dara or Hadi (browser, Cloudflare dashboard).  
**Where:** https://dash.cloudflare.com/profile/api-tokens → (scroll to Global API Key section) → delete.

**Before revoking:**
1. Confirm all 11 services are running and healthy
2. Confirm no recent auth failures in any logs
3. Run a final health check on each consumer

**After revoking:**
1. Monitor for the next 24 hours for any `401 Unauthorized` errors from services trying to use the deleted key
2. If errors appear, stop services immediately and restore (from dashboard history, if available) or re-mint a temporary key
3. Investigate why that consumer wasn't migrated fully

---

## Appendix: Service Unit Modification Template

**Current pattern (with `.env.secrets`):**
```ini
[Service]
EnvironmentFile=/home/mumega/.env.secrets
ExecStart=/usr/bin/python3 /path/to/script.py
```

**New pattern (per-consumer token file):**
```ini
[Service]
# Source the specific consumer token instead of the blanket .env.secrets
# This keeps the token out of logging and reduces blast radius
ExecStartPre=/bin/sh -c 'export MY_CONSUMER_TOKEN=$(cat /home/mumega/.sos/keys/consumer-N-token) && \
  if [ -z "$MY_CONSUMER_TOKEN" ]; then echo "Token file missing" >&2; exit 1; fi'
ExecStart=/usr/bin/python3 -c 'import os; ... use os.environ["MY_CONSUMER_TOKEN"] ...'

# OR if using EnvironmentFile is unavoidable:
EnvironmentFile=/home/mumega/.sos/keys/consumer-N-env
# (with consumer-N-env containing ONLY: MY_CONSUMER_TOKEN=<token>)
```

---

## Timeline

| Phase | Status | Blocker | Est. Completion |
|-------|--------|---------|-----------------|
| **Phase 1: Identify** | ✅ Done | None | 2026-08-08 |
| **Phase 2: Mint** | ⏳ Blocked | mupot#764 (`.env.secrets` leakage) | After leakage fixed |
| **Phase 3: Cutover** | ⏳ Waiting | Mint complete | Staggered: 1 consumer/day × 11 = ~2 weeks |
| **Phase 4: Verify** | ⏳ Waiting | Cutover complete | Same timeline as cutover |
| **Phase 5: Revoke** | ⏳ Waiting | All consumers verified | After Phase 4 |

---

## Risk Mitigations

| Risk | Mitigation |
|------|-----------|
| Mint fails due to permission issue | Re-verify `kasra` token has `Account API Tokens:Write` permission |
| New token fails intermittently | Always use `curl -4` (IPv4-only); allow 20s for token propagation before testing |
| Service has no visibility into why auth failed | Add logging: "CF API call to {endpoint} returned {status}" (without token value) |
| Revocation breaks a service mid-way through cutover | Keep the Global Key active until 100% verification complete; risk is low but penalty is high |
| Multiple services migrate at once and fail together | Stagger cutover: one consumer at a time; verify before next |

---

## Sign-Off (to be filled)

- [ ] Phase 1 (findings) reviewed and approved
- [ ] Phase 2 minting reviewed and ready
- [ ] Phase 3 cutover order approved
- [ ] Phase 4 verification criteria acceptable
- [ ] Phase 5 revocation approved by credential owner
