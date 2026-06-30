#!/bin/bash
# Register an agent's PUBLIC key in the pot (agent_keys) so signed-attach can verify it.
#
#   TENANT_SLUG=<your-tenant> ./register-agent-key.sh <agent_id> <pubkey_b64url> [member_id]
#
# Writes ONLY public material (the Ed25519 public x-coordinate) into D1 via wrangler. No secret
# crosses. Run in YOUR terminal (needs wrangler access to the pot worker). STERILE: TENANT_SLUG
# is REQUIRED — this script hardcodes no tenant.
#
# member_id (optional) binds the key to the pot member this agent authenticates AS. Resolve it:
#   npx wrangler d1 execute <db> --remote --json \
#     --command "SELECT id, display_name FROM members WHERE tenant='<your-tenant>';"
set -euo pipefail

# DB name + repo dir are pot-local; override via env if your fork differs.
POT_DIR="${POT_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
D1_DB="${D1_DB:-mupot}"
cd "$POT_DIR"

AGENT="${1:?usage: TENANT_SLUG=<t> register-agent-key.sh <agent_id> <pubkey_b64url> [member_id]}"
PUBKEY="${2:?missing pubkey}"
MEMBER="${3:-}"
TENANT="${TENANT_SLUG:?set TENANT_SLUG=<your-tenant> (this runtime hardcodes no tenant)}"

if ! [[ "$AGENT" =~ ^[a-z0-9][a-z0-9-]{0,63}$ ]]; then
  echo "bad agent_id: $AGENT" >&2; exit 2
fi
if ! [[ "$PUBKEY" =~ ^[A-Za-z0-9_-]{40,64}$ ]]; then
  echo "bad pubkey (expect base64url Ed25519 x, 43 chars): $PUBKEY" >&2; exit 2
fi

if [[ -n "$MEMBER" ]]; then MEMBER_SQL="'$MEMBER'"; else MEMBER_SQL="NULL"; fi

echo "Registering pubkey for ${TENANT}/${AGENT} (member_id=${MEMBER:-NULL}) in D1 '${D1_DB}'…"
npx wrangler d1 execute "$D1_DB" --remote --command \
  "INSERT INTO agent_keys (tenant, agent_id, pubkey, algo, member_id, created_at)
   VALUES ('${TENANT}', '${AGENT}', '${PUBKEY}', 'Ed25519', ${MEMBER_SQL}, strftime('%s','now'))
   ON CONFLICT(tenant, agent_id) DO UPDATE SET
     pubkey=excluded.pubkey, algo=excluded.algo, member_id=excluded.member_id,
     created_at=excluded.created_at;"

echo "Done. Verify:"
npx wrangler d1 execute "$D1_DB" --remote --command \
  "SELECT agent_id, substr(pubkey,1,12)||'…' AS pubkey, member_id, created_at
   FROM agent_keys WHERE tenant='${TENANT}' AND agent_id='${AGENT}';"
