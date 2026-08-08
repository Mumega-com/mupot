#!/bin/bash
# cf-mint-shabrang-token.sh
# Mint replacement Cloudflare API token for Shabrang Astro Pages deploy
#
# Usage:
#   export CF_ADMIN_TOKEN=$(cat ~/.sos/keys/kasra.token)  # or your admin token
#   bash scripts/cf-mint-shabrang-token.sh
#
# Exit codes:
#   0 = success, token printed to stdout
#   1 = error (e.g., missing env vars, API failure)
#   2 = user cancelled
#
# Output format on success:
#   <token_id>|<token_secret>
#

set -euo pipefail

# ============================================================================
# CONFIG
# ============================================================================

ACCOUNT_ID="e39eaf94f33092c4efd029d94ae1e9dd"
ZONE_ID="e39eaf94f33092c4efd029d94ae1e9dd"  # mumega.com
TOKEN_NAME="shabrang-pages-deploy-$(date -u +%Y%m%d)"
EXPIRES_DAYS=90
EXPIRES_ON=$(date -u -d "+${EXPIRES_DAYS} days" +"%Y-%m-%dT%H:%M:%SZ")

# ============================================================================
# VALIDATE ENVIRONMENT
# ============================================================================

if [[ -z "${CF_ADMIN_TOKEN:-}" ]]; then
  echo "Error: CF_ADMIN_TOKEN not set"
  echo "Usage: export CF_ADMIN_TOKEN=\$(cat ~/.sos/keys/kasra.token) && bash scripts/cf-mint-shabrang-token.sh"
  exit 1
fi

# ============================================================================
# DISCOVER PERMISSION IDs
# ============================================================================

echo "Discovering Cloudflare permission IDs..." >&2

PERMS_JSON=$(curl -s -X GET "https://api.cloudflare.com/client/v4/user/permissions" \
  -H "Authorization: Bearer $CF_ADMIN_TOKEN" \
  -H "Content-Type: application/json")

PAGES_EDIT_ID=$(echo "$PERMS_JSON" | jq -r '.result[] | select(.name | startswith("Cloudflare Pages")) | select(.description | contains("Edit")) | .id' | head -1)
ACCOUNT_SETTINGS_READ_ID=$(echo "$PERMS_JSON" | jq -r '.result[] | select(.name == "Account Settings") | select(.description | contains("Read")) | .id' | head -1)

if [[ -z "$PAGES_EDIT_ID" || -z "$ACCOUNT_SETTINGS_READ_ID" ]]; then
  echo "Error: Failed to discover permission IDs"
  echo "Permissions response:" >&2
  echo "$PERMS_JSON" | jq '.' >&2
  exit 1
fi

echo "✓ Cloudflare Pages:Edit = $PAGES_EDIT_ID" >&2
echo "✓ Account Settings:Read = $ACCOUNT_SETTINGS_READ_ID" >&2

# ============================================================================
# MINT TOKEN
# ============================================================================

echo "Minting token: $TOKEN_NAME (expires $EXPIRES_ON)..." >&2

MINT_JSON=$(curl -s -X POST "https://api.cloudflare.com/client/v4/user/tokens" \
  -H "Authorization: Bearer $CF_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "'"$TOKEN_NAME"'",
    "description": "Shabrang Astro → mumega-inkwell Pages deploy (GitHub Actions CI)",
    "ttl": 3600,
    "not_before": "'$(date -u +"%Y-%m-%dT%H:%M:%SZ")'",
    "expires_on": "'"$EXPIRES_ON"'",
    "permissions": [
      {"id":"'"$PAGES_EDIT_ID"'"},
      {"id":"'"$ACCOUNT_SETTINGS_READ_ID"'"}
    ],
    "resources": {
      "com.cloudflare.api/account": {"account": "'"$ACCOUNT_ID"'"},
      "com.cloudflare.api/zone": {"zone": "'"$ZONE_ID"'"}
    }
  }')

# Check for errors
if ! echo "$MINT_JSON" | jq -e '.success' >/dev/null 2>&1; then
  echo "Error: Token minting failed"
  echo "Response:" >&2
  echo "$MINT_JSON" | jq '.' >&2
  exit 1
fi

# Extract token and ID
TOKEN_SECRET=$(echo "$MINT_JSON" | jq -r '.result.token')
TOKEN_ID=$(echo "$MINT_JSON" | jq -r '.result.id')

if [[ -z "$TOKEN_SECRET" || "$TOKEN_SECRET" == "null" ]]; then
  echo "Error: Token not returned from API"
  echo "Response:" >&2
  echo "$MINT_JSON" | jq '.' >&2
  exit 1
fi

# ============================================================================
# VERIFY AND OUTPUT
# ============================================================================

echo "✓ Token minted successfully" >&2
echo "  Name: $TOKEN_NAME" >&2
echo "  ID: $TOKEN_ID" >&2
echo "  Expires: $EXPIRES_ON" >&2
echo "" >&2
echo "Token (save this — it is only shown once):" >&2
echo "================================================" >&2

# Output: token_id|token_secret (or just token for use in secrets)
echo "$TOKEN_SECRET"
