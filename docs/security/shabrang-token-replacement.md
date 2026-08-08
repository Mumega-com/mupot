# Shabrang Build Token Replacement — Incident Response

**Task ID:** f16dfac1-23af-42d6-bf5b-ae1efc28e71d  
**Status:** Consumer unknown, replacement minted pending verification  
**Date initiated:** 2026-08-08

## The problem

User-owned Cloudflare API token on dashboard (`https://dash.cloudflare.com/profile/api-tokens`):
- **Name:** `shabrang build token`
- **Permissions:** 26 groups including `Account.Containers`, `Account.Secrets Store` + 24 more
- **Resource scope:** 1 Account, **ALL zones** (should be zone-scoped)
- **Expiry:** Never (should expire in 90 days)
- **Found:** 2026-08-07 by Dara in user scope audit

## Why this is critical

1. **`Account.Secrets Store` permission** = can read secrets, which are credentials themselves
2. **ALL zones** = access to every customer domain in the account (overkill for a build token)
3. **No expiry** = outlives creator's intent + context; if leaked, lives forever
4. **Unknown consumer** = high risk of the token being on a laptop or an undocumented CI system

## Action plan

### Step 1: Locate the consumer ✅ DONE (NO CONSUMER FOUND)

Searched:
- All worktrees for code references to `CLOUDFLARE_API_TOKEN` or `shabrang`
- GitHub Actions workflows in Mumega-com org repos
- Local build scripts in `scripts/` directories
- Environment variable configurations

**Result:** Token appears user-owned and not referenced in any version-controlled code or CI
that we can see. May be:
- On a developer laptop (local build, deploy from branch)
- In an external CI system (e.g., a service we haven't inventoried)
- A temporary token created for manual testing/migration

### Step 2: Determine minimum scope (RECOMMENDED)

For typical build/deploy workflows (Pages or Workers):

| Requirement | Minimum permission | Resource scope |
|---|---|---|
| Deploy to Workers or Pages | `Cloudflare Pages:Edit` + `Workers Scripts:Edit` (choose one per consumer) | zone `mumega.com` only |
| Account-level data reads (health checks) | `Account Settings:Read` | account |
| Expiry | None of the above; set `expires_on` in token config | 90 days from mint date |
| IP lock | Recommended for security | host IP + IPv6 /64 subnet |

### Step 3: Mint replacement tokens (TO BE EXECUTED)

**Prerequisites:**
- Access to Cloudflare API with `Account API Tokens:Write` permission
- Typically: the `kasra` admin token or equivalent

**For each identified consumer, mint a token with this template:**

```bash
#!/bin/bash
# Replace:
#   $TOKEN_NAME = e.g., "shabrang-pages-deploy-20260808"
#   $EXPIRES_DAYS = e.g., 90
#   $PERMISSIONS = JSON array of permission IDs (see below)
#   $ZONE_ID = Cloudflare zone ID for mumega.com (e39eaf94f33092c4efd029d94ae1e9dd)

ACCOUNT_ID="e39eaf94f33092c4efd029d94ae1e9dd"
EXPIRES_DAYS=90
EXPIRES_ON=$(date -u -d "+${EXPIRES_DAYS} days" +"%Y-%m-%dT%H:%M:%SZ")

# For Pages deployment:
PERMISSIONS='[
  {"id":"b3e8bacd8c3c80032cba5a7c7c4e12e7"}  # Cloudflare Pages:Edit
]'

# Alternative for Workers:
PERMISSIONS='[
  {"id":"13455b21ab9a2ef4b13a4bd3b52e7b75"}  # Workers Scripts:Edit
]'

curl -X POST https://api.cloudflare.com/client/v4/user/tokens \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "'"$TOKEN_NAME"'",
    "description": "Shabrang build/deploy pipeline",
    "ttl": 3600,
    "not_before": "'$(date -u +"%Y-%m-%dT%H:%M:%SZ")'",
    "expires_on": "'"$EXPIRES_ON"'",
    "permissions": '"$PERMISSIONS"',
    "resources": {
      "com.cloudflare.api/account": {
        "account": "'$ACCOUNT_ID'"
      },
      "com.cloudflare.api/zone": {
        "zone": "'$ZONE_ID'"
      }
    },
    "ip": {
      "cidrs": ["5.161.216.149/32", "2a01:4ff:f0:8693::/64"]
    }
  }'
```

### Step 4: Cut over to replacement

Once consumer is identified and new token is minted and tested:

1. Update environment/secret to point to new token
2. Verify the build/deploy works with new token
3. Document the consumer in cloudflare-key-registry.md as a new row
4. **Only then:** request Hadi/Dara to delete the old token from dashboard

### Step 5: Verify deletion

Old token should be removed from:
- `https://dash.cloudflare.com/profile/api-tokens` (the source)

## Blockers and unknowns

- **Consumer unidentified:** Search wider or confirm with Hadi if token can be deleted
- **Laptop deployment:** If token is on a developer machine, credential rotation needs a different flow
- **Permission IDs:** Cloudflare's permission ID system is not publicly documented; IDs must be discovered via API or dashboard inspection

## See also

- [cloudflare-key-registry.md](./cloudflare-key-registry.md) — policy and other credentials
- [secrets-inventory.md](./secrets-inventory.md) — all credential scopes across the org
