#!/usr/bin/env bash
# Read-only listing of GitHub App installation bindings per tenant (see the .sql beside it).
# usage: scripts/github-install-bindings-audit.sh <d1-database-name> [--local]
# Uses the operator's existing wrangler login; this script reads no secrets and writes nothing.
set -euo pipefail
db="${1:?usage: $0 <d1-database-name> [--local]}"
mode="${2:---remote}"
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sql="$dir/github-install-bindings-audit.sql"
# Guard: the file must contain only SELECT statements.
if grep -Eiq '\b(insert|update|delete|drop|alter|create|replace)\b' <(grep -v '^--' "$sql"); then
  echo "refusing: audit SQL is not read-only" >&2; exit 2
fi
exec npx wrangler d1 execute "$db" "$mode" --file "$sql"
