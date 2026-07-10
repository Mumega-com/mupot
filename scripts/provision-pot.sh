#!/usr/bin/env bash
# Provision one isolated self-hosted pot and write its complete Wrangler config.
#
# Usage: scripts/provision-pot.sh <pot-slug>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "${1:-}" in
  --help|-h)
    exec bash "${SCRIPT_DIR}/setup.sh" --help
    ;;
  '')
    printf 'usage: scripts/provision-pot.sh <pot-slug>   (e.g. acme)\n' >&2
    exit 1
    ;;
esac

POT="$1"

exec bash "${SCRIPT_DIR}/setup.sh" --pot "${POT}"
