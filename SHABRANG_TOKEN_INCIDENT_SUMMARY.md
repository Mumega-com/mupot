# Shabrang Build Token Incident — Summary & Handoff

**Task ID:** f16dfac1-23af-42d6-bf5b-ae1efc28e71d  
**Status:** Investigation complete, replacement ready for execution  
**Date:** 2026-08-08  
**Agent:** Claude Code (Headless build lane for Kasra)

## Executive Summary

Found and investigated user-owned Cloudflare API token (`shabrang build token`)
with 26 overprivileged permission groups, ALL zones access, and no expiry.

**Consumer identified:** `Mumega-com/shabrang` GitHub repository (Astro site → Cloudflare
Pages deploy via GitHub Actions)

**Plan:** Mint scoped replacement token, test with workflow, verify, then delete old
token from dashboard (human gate).

**Status:** All investigation and preparation complete. Ready for Kasra to execute
scripts using CF admin token.

## What was found

| Item | Details |
|---|---|
| **Token name** | `shabrang build token` |
| **Found** | 2026-08-07 by Dara (Cloudflare dashboard, user scope) |
| **Repository** | `Mumega-com/shabrang` |
| **Workflow** | `.github/workflows/deploy.yml:L23-27` |
| **Purpose** | Astro site build + deploy to Cloudflare Pages (mumega-inkwell project) |
| **Current scope** | 26 permissions, ALL zones, no expiry (dangerous) |
| **Minimum scope** | Cloudflare Pages:Edit + Account Settings:Read, zone mumega.com, 90-day expiry |

## What was done

### Investigation
- ✅ Searched all worktrees, GitHub Actions workflows, build scripts
- ✅ Identified Shabrang repository and deploy workflow
- ✅ Confirmed workflow references `secrets.CLOUDFLARE_API_TOKEN`
- ✅ Verified workflow uses `wrangler pages deploy`

### Documentation
- ✅ Updated `docs/security/cloudflare-key-registry.md` (row #12)
- ✅ Updated `docs/security/secrets-inventory.md` with incident flag
- ✅ Created `docs/security/shabrang-token-replacement.md` with full action plan

### Automation
- ✅ Created `scripts/cf-mint-shabrang-token.sh` — mints token with discovered permission IDs
- ✅ Created `scripts/cf-rotate-shabrang-token.sh` — full workflow (mint → test → report)

### Commits
```
49ab3db [SEC] Add scripts for shabrang token minting and rotation workflow
cf78db7 [SEC] Complete shabrang build token investigation, prepare replacement
5464ba2 [SEC] Document shabrang build token incident, add replacement plan
```

## Next steps for execution

### For Kasra (or whoever has CF admin token):

1. **Run the rotation script:**
   ```bash
   export CF_ADMIN_TOKEN=$(cat ~/.sos/keys/kasra.token)
   cd /mnt/HC_Volume_104325311/mupot-worktrees/claude-f16dfac1
   bash scripts/cf-rotate-shabrang-token.sh
   ```

2. **The script will:**
   - Discover Cloudflare permission IDs
   - Mint new token (minimal scope)
   - Update GitHub Actions secret in Mumega-com/shabrang
   - Trigger deploy workflow to test new token
   - Report workflow status and next steps

### For Hadi/Dara (dashboard access for deletion):

1. **Verify the workflow succeeded** at the GitHub Actions URL provided by script
2. **Check live Shabrang site** deployed successfully with new token
3. **Delete old token** from Cloudflare dashboard:
   - Go to: `https://dash.cloudflare.com/profile/api-tokens`
   - Find: `shabrang build token` (26 permissions, ALL zones, no expiry)
   - Click delete
4. **Confirm it's gone** — should not appear in list anymore

## What's in the commits

### 5464ba2 — Initial incident documentation
- Added incident row #12 to cloudflare-key-registry.md
- Marked as "UNKNOWN CONSUMER" pending investigation
- Created shabrang-token-replacement.md with initial plan
- Updated secrets-inventory.md with incident flag

### cf78db7 — Completed investigation
- Updated row #12 to show consumer identified
- Moved from "UNKNOWN" to "pending token swap"
- Added detailed action plan with steps 1-5
- Updated replacement.md with Shabrang-specific instructions

### 49ab3db — Automation scripts
- cf-mint-shabrang-token.sh: API-based token minting
- cf-rotate-shabrang-token.sh: full rotation workflow
- Both scripts documented, tested for syntax, ready to run

## Files changed

```
docs/security/cloudflare-key-registry.md (updated row #12)
docs/security/secrets-inventory.md (added incident marker)
docs/security/shabrang-token-replacement.md (created — full plan)
scripts/cf-mint-shabrang-token.sh (created — executable)
scripts/cf-rotate-shabrang-token.sh (created — executable)
```

## Verification checklist before deletion

- [ ] Workflow run completed successfully (GitHub Actions logs)
- [ ] Astro site deployed (check Pages deployment in Cloudflare or live URL)
- [ ] GitHub Actions secret updated in Mumega-com/shabrang
- [ ] New token verified working (no auth errors in workflow logs)
- [ ] Old token documented as "replaced" in audit trail (this commit)
- [ ] Old token deleted from dashboard (final step)

## References

- `docs/security/cloudflare-key-registry.md` — credential policy and registry
- `docs/security/shabrang-token-replacement.md` — full incident response plan
- `docs/security/secrets-inventory.md` — complete credential inventory
- `scripts/cf-mint-shabrang-token.sh` — token minting automation
- `scripts/cf-rotate-shabrang-token.sh` — end-to-end rotation workflow

---

**Status:** Investigation complete, ready for execution. Kasra can run
`scripts/cf-rotate-shabrang-token.sh` with CF admin token to proceed.
