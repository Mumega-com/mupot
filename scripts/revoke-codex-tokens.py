#!/usr/bin/env python3
"""
Revoke legacy bare-codex bus tokens.

Context: Codex seat consolidated into LOOM (Hadi). Bare-codex tokens
allowed identity squatting (off-host session registered as agent:codex
and ACK'd a constitution vote). Fix: revoke all active "codex" agent
entries; keep mumvps-codex + loom tokens (separate identities).

Safe: sets active=false on tokens with agent=="codex" only. Non-destructive
backup: original tokens.json written to .bak before any changes.

Usage:
  python3 scripts/revoke-codex-tokens.py /path/to/tokens.json
  echo $?  # 0=success (tokens revoked), 1=error or no codex tokens found
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


def revoke_codex_tokens(tokens_path: str) -> tuple[int, str]:
    """
    Revoke all active tokens with agent=='codex'.
    Returns (exit_code, message).
    exit_code: 0=success, 1=error or no codex tokens found.
    """
    tokens_path = Path(tokens_path)

    if not tokens_path.exists():
        return 1, f"tokens.json not found: {tokens_path}"

    try:
        with open(tokens_path) as f:
            tokens = json.load(f)
    except json.JSONDecodeError as e:
        return 1, f"tokens.json parse error: {e}"
    except OSError as e:
        return 1, f"read error: {e}"

    if not isinstance(tokens, list):
        return 1, "tokens.json root must be a list"

    # Find active codex tokens (not project-scoped, not suffixed like "hadi-codex").
    # Bare-codex = agent field is exactly "codex".
    codex_tokens = [
        (i, t)
        for i, t in enumerate(tokens)
        if isinstance(t, dict) and t.get("agent") == "codex" and t.get("active") is True
    ]

    if not codex_tokens:
        return 1, "no active bare-codex tokens found (already revoked or not present)"

    # Write backup.
    backup_path = tokens_path.with_suffix(".json.bak")
    try:
        backup_path.write_text(json.dumps(tokens, indent=2))
    except OSError as e:
        return 1, f"backup write failed: {e}"

    # Revoke.
    revoked_count = 0
    for i, token in codex_tokens:
        label = token.get("label", "(no label)")
        tokens[i]["active"] = False
        tokens[i]["deactivation_reason"] = (
            "legacy bare-codex identity retired; squatting risk mitigated; "
            "consolidated into loom (Hadi). 2026-08-08 task #90075f12"
        )
        revoked_count += 1
        print(f"  Revoked: {label}")

    # Write back.
    try:
        with open(tokens_path, "w") as f:
            json.dump(tokens, f, indent=2)
            f.write("\n")  # add trailing newline
    except OSError as e:
        return 1, f"write failed (backup saved at {backup_path}): {e}"

    return 0, f"Revoked {revoked_count} bare-codex token(s). Backup: {backup_path}"


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <path-to-tokens.json>", file=sys.stderr)
        sys.exit(1)

    exit_code, msg = revoke_codex_tokens(sys.argv[1])
    print(msg)
    sys.exit(exit_code)
