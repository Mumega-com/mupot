// scripts/mint-kasra-workspace-admin-token.ts — reference for minting workspace admin token for kasra.
//
// CONTEXT: This script documents the process for minting a workspace admin token for kasra,
// enabling kasra to call mupot's routine_create and grant_gate_capability endpoints.
//
// MANUAL STEP (Hadi's admin seat required):
// The actual token minting happens through the dashboard at:
//   GET /members — find kasra's member record
//   POST /members/<kasra_member_id>/tokens — mint token with label "kasra-workspace-admin"
//
// This is NOT an automated script — the token must be minted by Hadi's authenticated session
// because the dashboard gate checks isAdmin() before allowing the mint.
//
// After minting:
// 1. Copy the raw token shown on the dashboard (shown ONCE, never retrievable again)
// 2. Wire it to kasra's local mupot connection (e.g., ~/.fleet/mupot.token or wrangler env)
// 3. Test by calling: mupot routine_create via the MCP endpoint
//
// The token will carry kasra's member identity and resolve to org-scope admin capability
// via the capabilities table (populated by 0086_kasra_workspace_admin.sql migration).

// Step-by-step reference (manual, via dashboard):
// 1. Ensure migration 0086_kasra_workspace_admin.sql has been applied
//    ✓ Grants org-scope admin capability to kasra member
// 2. Login to mupot dashboard as Hadi (org owner)
// 3. Navigate to /members
// 4. Find "Kasra" in the members list
// 5. Click "Mint token" button (or POST /members/<id>/tokens)
// 6. Fill form:
//    - Label: "kasra-workspace-admin"
//    - Channel: "workspace"
// 7. Click "Mint"
// 8. Copy the raw token (shown once, never retrievable)
// 9. Store in kasra's local mupot config:
//    - Option A: ~/.fleet/mupot/workspace_admin.token
//    - Option B: wrangler env var: MUPOT_ADMIN_TOKEN
//    - Option C: claude.ai connector settings → mupot adapter
// 10. Test: call mupot routine_create via MCP

// See also:
// - src/members/service.ts: mintMemberToken() — the backend service
// - src/dashboard/index.ts: POST /members/:id/tokens — the dashboard route
// - migrations/0086_kasra_workspace_admin.sql — grants capability

console.log('Workspace admin token mint reference: see comments in this file.')
console.log('This is a reference document, not an executable script.')
console.log('')
console.log('Key points:')
console.log('1. Migration 0086 grants kasra org-scope admin capability')
console.log('2. Token mint happens via dashboard (manual, Hadi-gated)')
console.log('3. Token resolves kasra member → org-scope admin → routine_create succeeds')
console.log('')
console.log('Next steps:')
console.log('1. Apply migration 0086_kasra_workspace_admin.sql')
console.log('2. Hadi: visit https://mupot.mumega.com/members and mint token for kasra')
console.log('3. Wire token to kasra\'s local mupot connection')
console.log('4. Test routine_create call')
