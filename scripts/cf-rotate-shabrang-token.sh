#!/bin/bash
# cf-rotate-shabrang-token.sh
# Complete workflow to rotate the Shabrang build token (mint → test → verify → document)
#
# Usage:
#   export CF_ADMIN_TOKEN=$(cat ~/.sos/keys/kasra.token)
#   bash scripts/cf-rotate-shabrang-token.sh
#
# Steps:
#   1. Mint new token with minimal scope
#   2. Update GitHub Actions secret in Mumega-com/shabrang
#   3. Trigger deploy workflow to verify new token works
#   4. Report status
#
# Prerequisites:
#   - CF_ADMIN_TOKEN set (Kasra or admin token)
#   - gh CLI authenticated and org-admin access to Mumega-com/shabrang
#

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'  # No Color

REPO="Mumega-com/shabrang"
SECRET_NAME="CLOUDFLARE_API_TOKEN"

log_info() { echo -e "${GREEN}✓${NC} $*"; }
log_warn() { echo -e "${YELLOW}⚠${NC} $*"; }
log_error() { echo -e "${RED}✗${NC} $*" >&2; }

# ============================================================================
# STEP 1: MINT NEW TOKEN
# ============================================================================

echo ""
log_info "Step 1: Minting new Cloudflare token..."

if ! NEW_TOKEN=$(bash scripts/cf-mint-shabrang-token.sh 2>&1); then
  log_error "Token minting failed"
  echo "$NEW_TOKEN" >&2
  exit 1
fi

log_info "New token minted"
log_info "Token preview: ${NEW_TOKEN:0:20}..."

# ============================================================================
# STEP 2: UPDATE GITHUB ACTIONS SECRET
# ============================================================================

echo ""
log_info "Step 2: Updating GitHub Actions secret in $REPO..."

if ! gh secret set "$SECRET_NAME" \
  --repo "$REPO" \
  --body "$NEW_TOKEN"; then
  log_error "Failed to update GitHub secret"
  exit 1
fi

log_info "GitHub Actions secret updated"

# ============================================================================
# STEP 3: TRIGGER DEPLOY WORKFLOW
# ============================================================================

echo ""
log_info "Step 3: Triggering deploy workflow to verify new token..."

if ! RUN_ID=$(gh workflow run deploy.yml \
  --repo "$REPO" \
  --ref main \
  --json databaseId -q '.databaseId'); then
  log_error "Failed to trigger workflow"
  exit 1
fi

log_info "Workflow triggered: run $RUN_ID"
log_info "Monitor at: https://github.com/$REPO/actions/runs/$RUN_ID"

# ============================================================================
# STEP 4: MONITOR WORKFLOW (wait up to 5 minutes)
# ============================================================================

echo ""
log_info "Step 4: Monitoring workflow (up to 5 minutes)..."

TIMEOUT=300
ELAPSED=0
POLL_INTERVAL=10

while [[ $ELAPSED -lt $TIMEOUT ]]; do
  STATUS=$(gh run view "$RUN_ID" --repo "$REPO" -q '.status' 2>/dev/null || echo "unknown")

  case "$STATUS" in
    "completed")
      CONCLUSION=$(gh run view "$RUN_ID" --repo "$REPO" -q '.conclusion' 2>/dev/null)
      if [[ "$CONCLUSION" == "success" ]]; then
        log_info "Workflow completed successfully ✓"
        break
      else
        log_error "Workflow failed with conclusion: $CONCLUSION"
        exit 1
      fi
      ;;
    "in_progress"|"queued")
      echo -ne "\r  Elapsed: ${ELAPSED}s (status: $STATUS)  "
      sleep "$POLL_INTERVAL"
      ELAPSED=$((ELAPSED + POLL_INTERVAL))
      ;;
    *)
      log_warn "Workflow status unknown: $STATUS"
      break
      ;;
  esac
done

if [[ $ELAPSED -ge $TIMEOUT ]]; then
  log_warn "Workflow did not complete within timeout; continuing anyway"
  log_info "Check status manually: https://github.com/$REPO/actions/runs/$RUN_ID"
fi

# ============================================================================
# STEP 5: SUMMARY AND NEXT STEPS
# ============================================================================

echo ""
echo "========================================================================"
log_info "Token rotation workflow complete"
echo "========================================================================"
echo ""
echo "Summary:"
echo "  • New token: minted and scoped (Cloudflare Pages:Edit + Account Settings:Read)"
echo "  • GitHub secret: updated in $REPO"
echo "  • Workflow: triggered to verify new token"
echo "  • Status: https://github.com/$REPO/actions/runs/$RUN_ID"
echo ""
echo "Next steps (MANUAL — human gate):"
echo "  1. Verify Pages deployment succeeded at deploy workflow link above"
echo "  2. Check live site: https://mumega-inkwell.pages.dev (or Shabrang production URL)"
echo "  3. If successful, delete old 'shabrang build token' from:"
echo "     https://dash.cloudflare.com/profile/api-tokens"
echo "  4. Update docs/security/cloudflare-key-registry.md to mark row #12 as ✅"
echo ""
echo "⚠  DO NOT delete the old token until you verify the new one works!"
echo ""
