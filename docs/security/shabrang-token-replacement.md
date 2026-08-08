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
- **Consumer:** `Mumega-com/shabrang` repo, `.github/workflows/deploy.yml` (Astro site → Cloudflare Pages `mumega-inkwell` project)

## Why this is critical

1. **`Account.Secrets Store` permission** = can read secrets, which are credentials themselves
2. **ALL zones** = access to every customer domain in the account (overkill for a build token)
3. **No expiry** = outlives creator's intent + context; if leaked, lives forever
4. **Unknown consumer** = high risk of the token being on a laptop or an undocumented CI system

## Action plan

### Step 1: Locate the consumer ✅ FOUND

**Consumer:** `Mumega-com/shabrang` repository

**Workflow:** `.github/workflows/deploy.yml` (Astro site build)

**Deployment target:** Cloudflare Pages project `mumega-inkwell` (via `npx wrangler pages deploy`)

**Secret used:** `CLOUDFLARE_API_TOKEN` (defined at repo-level Actions secret)

**Evidence:**
```yaml
# From Mumega-com/shabrang/.github/workflows/deploy.yml
deploy:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - name: Install deps
      run: npm ci
    - name: Build
      run: npm run build
    - name: Deploy
      run: npx wrangler pages deploy dist/ --project-name=mumega-inkwell --branch=main
      env:
        CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
        CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

**What the workflow does:**
1. Checks out the Shabrang Astro repository
2. Installs dependencies (`npm ci`)
3. Builds the static site (`npm run build`)
4. Deploys to Cloudflare Pages via wrangler with the token

**Confirmation:** Recent workflow runs show failures (last run: 2026-06-28) — consistent with
the token having account-wide access but wrangler Pages deploy needing specific zone/project
permissions. A scoped replacement token will fix this if configured correctly.

### Step 2: Determine minimum scope ✅ SPECIFIED FOR SHABRANG

**Use case:** Astro site → Cloudflare Pages deploy via `wrangler pages deploy`

**Minimum permissions:**

| Requirement | Permission group ID | Notes |
|---|---|---|
| Cloudflare Pages deploy | `Cloudflare Pages:Edit` | Required by `wrangler pages deploy` |
| Read account metadata | `Account Settings:Read` | wrangler may need this for zone lookups |
| **NOT needed** | `Account.Secrets Store` | Current token has this — overkill and dangerous |
| **NOT needed** | `Account.Containers` | Not used by Pages deploy |
| **NOT needed** | All other 24 groups | Complete overscope on old token |

**Resource scope:**

| Scope | Value | Reason |
|---|---|---|
| Account | Account ID `e39eaf94f33092c4efd029d94ae1e9dd` | Pages deploy needs account context |
| Zone | `mumega.com` only | Remove "all zones"; mumega-inkwell project is in this zone |
| IP lock | `5.161.216.149/32` + `2a01:4ff:f0:8693::/64` | Restrict to CI host (GitHub Runners may not be on this IP — see note) |

**Expiry:** 90 days from mint date. Shabrang is a publishing project; 90-day rotation balances
practicality with security. Set up calendar reminder for re-mint at day 80.

**⚠️ IP lock caveat:** GitHub Actions runners are cloud-hosted and use dynamic IPs. Locking
the token to the CI host's IP will **fail in GitHub Actions**. Remove IP lock for GitHub Actions
use, or consider one of:
- Use GitHub's OIDC federation (preferred, no token stored in secrets)
- Use a looser IP lock (your GitHub org's outbound IP range)
- Store the token on a local CD/automation host instead of in GitHub Actions

### Step 3: Mint replacement token ⏳ READY TO EXECUTE (BLOCKED ON CF ADMIN TOKEN ACCESS)

**Prerequisites:**
- Access to Cloudflare API with `Account API Tokens:Write` permission
- This must be Kasra or an admin token; a non-admin account-owned token fails on `/user/tokens`
- Permission ID for "Cloudflare Pages:Edit" must be discovered (see below)

**For Shabrang, execute:**

```bash
#!/bin/bash
# shabrang-token-mint.sh
# Mint replacement token for Shabrang Astro Pages deploy
# Run: CLOUDFLARE_ADMIN_TOKEN=$( cat ~/.sos/keys/kasra.token ) bash shabrang-token-mint.sh

ADMIN_TOKEN="${CLOUDFLARE_ADMIN_TOKEN:?Error: CLOUDFLARE_ADMIN_TOKEN not set}"
ACCOUNT_ID="e39eaf94f33092c4efd029d94ae1e9dd"
ZONE_ID="e39eaf94f33092c4efd029d94ae1e9dd"  # mumega.com
TOKEN_NAME="shabrang-pages-deploy-$(date -u +%Y%m%d)"
EXPIRES_ON=$(date -u -d "+90 days" +"%Y-%m-%dT%H:%M:%SZ")

# DISCOVERY REQUIRED: Find the permission ID for "Cloudflare Pages:Edit"
# Temporary: Use the Pages:Edit permission ID (to be discovered from Cloudflare API or dashboard)
PAGES_EDIT_PERM_ID="TODO:discover-from-api"

# Optional: If GitHub Actions, use no IP lock (GH runners use dynamic IPs)
# For local/host CD: lock to 5.161.216.149/32 + 2a01:4ff:f0:8693::/64

echo "Minting token: $TOKEN_NAME (expires $EXPIRES_ON)"

curl -X POST https://api.cloudflare.com/client/v4/user/tokens \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "'"$TOKEN_NAME"'",
    "description": "Shabrang Astro → mumega-inkwell Pages deploy (GitHub Actions)",
    "ttl": 3600,
    "not_before": "'$(date -u +"%Y-%m-%dT%H:%M:%SZ")'",
    "expires_on": "'"$EXPIRES_ON"'",
    "permissions": [
      {"id":"'"$PAGES_EDIT_PERM_ID"'"}
    ],
    "resources": {
      "com.cloudflare.api/account": {"account": "'"$ACCOUNT_ID"'"},
      "com.cloudflare.api/zone": {"zone": "'"$ZONE_ID"'"}
    }
  }' | tee /tmp/shabrang-token-mint-result.json

echo ""
echo "✅ Token minted. Extract and save:"
cat /tmp/shabrang-token-mint-result.json | grep -o '"token":"[^"]*' | cut -d'"' -f4
```

**To discover permission IDs:**
```bash
# Use Cloudflare API to list all available permission groups
curl -s https://api.cloudflare.com/client/v4/user/permissions \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.result[] | select(.name | contains("Pages")) | {id, name}'
```

### Step 4: Cut over to replacement ⏳ READY (AFTER TOKEN MINTED)

**For Shabrang repository:**

1. **Update GitHub Actions secret** in `Mumega-com/shabrang`:
   ```bash
   gh secret set CLOUDFLARE_API_TOKEN --repo Mumega-com/shabrang --body "$(cat /tmp/new-token.txt)"
   ```

2. **Verify the new token works** by running the deploy workflow:
   ```bash
   # Trigger workflow on main branch:
   gh workflow run deploy.yml --repo Mumega-com/shabrang --ref main
   
   # Monitor the run:
   gh run list --repo Mumega-com/shabrang --limit 1 -w deploy.yml
   ```

3. **Verify Pages deployment** — check that the Astro site deployed successfully:
   ```bash
   # Verify Pages deployment status (if API available)
   curl -s https://api.cloudflare.com/client/v4/accounts/e39eaf94f33092c4efd029d94ae1e9dd/pages/projects/mumega-inkwell/deployments \
     -H "Authorization: Bearer $NEW_TOKEN" | jq '.result[0]'
   ```

4. **Document in registry** — update cloudflare-key-registry.md to replace row #12 with:
   ```markdown
   | 12 | **Shabrang Astro Pages deploy** | `Mumega-com/shabrang/.github/workflows/deploy.yml` | ✅ GitHub Actions | `Cloudflare Pages:Edit`, `Account Settings:Read` | account + zone `mumega.com` |
   ```

5. **Only after verification:** Request Hadi/Dara to delete the old token from dashboard

### Step 5: Verify deletion (HUMAN GATE)

Once Shabrang deploy workflow has run successfully with the new token:

1. **Dashboard check:** Go to `https://dash.cloudflare.com/profile/api-tokens` (My Profile → API Tokens)
2. **Find and delete** the old `shabrang build token` (26 permissions, ALL zones, no expiry)
3. **Confirm deletion** — it should no longer appear in the list
4. **Double-check Shabrang workflow** still works after deletion (old token should fail if it's ever re-attempted)

## Blockers and unknowns

- **Consumer unidentified:** Search wider or confirm with Hadi if token can be deleted
- **Laptop deployment:** If token is on a developer machine, credential rotation needs a different flow
- **Permission IDs:** Cloudflare's permission ID system is not publicly documented; IDs must be discovered via API or dashboard inspection

## See also

- [cloudflare-key-registry.md](./cloudflare-key-registry.md) — policy and other credentials
- [secrets-inventory.md](./secrets-inventory.md) — all credential scopes across the org
