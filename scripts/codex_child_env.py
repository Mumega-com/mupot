#!/usr/bin/env python3
"""Pure helpers for Codex topology-A child env + sandbox caps.

Kept separate from codex-worker.py so offline conformance can import without
running the driver entrypoint.
"""
from __future__ import annotations

from typing import Mapping

VALID_SANDBOX = frozenset({"read-only", "workspace-write"})
DISALLOWED_SANDBOX = frozenset({"danger-full-access"})

# Minimal allowlist for the untrusted `codex exec` child. Never inherit the
# operator env (GITHUB/cloud/deploy creds are an exfil path via prompt injection).
CODEX_CHILD_ENV_ALLOWLIST = frozenset(
    {"PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "USER", "CODEX_HOME"}
)
FORBIDDEN_CHILD_ENV_PREFIXES = (
    "GITHUB_",
    "GH_",
    "AWS_",
    "CLOUDFLARE_",
    "CF_",
    "DEPLOY_",
    "WRANGLER_",
    "NPM_TOKEN",
    "NODE_AUTH_TOKEN",
)


def resolve_sandbox(raw: str) -> str:
    """Cap topology-A at workspace-write; refuse danger-full-access."""
    mode = raw.strip()
    if mode in DISALLOWED_SANDBOX:
        raise ValueError(
            f"SANDBOX={mode!r} is disallowed for topology-A (arms-never-deploy); "
            f"cap at workspace-write (allowed: {sorted(VALID_SANDBOX)})"
        )
    if mode not in VALID_SANDBOX:
        raise ValueError(f"SANDBOX must be one of {sorted(VALID_SANDBOX)}, got {mode!r}")
    return mode


def build_codex_child_env(
    parent_env: Mapping[str, str],
    *,
    mcp_env_var: str,
    token: str,
) -> dict[str, str]:
    """Minimal allowlisted env for `codex exec` — no GitHub/cloud/deploy creds."""
    if not mcp_env_var or not isinstance(mcp_env_var, str):
        raise ValueError("mcp_env_var required")
    if not token or not isinstance(token, str):
        raise ValueError("token required")
    child: dict[str, str] = {}
    for key in CODEX_CHILD_ENV_ALLOWLIST:
        value = parent_env.get(key)
        if isinstance(value, str) and value:
            child[key] = value
    # Defense: never copy a forbidden credential even if someone adds it to the allowlist.
    for key in list(child):
        upper = key.upper()
        if upper in {"GITHUB_TOKEN", "GH_TOKEN"} or any(
            upper.startswith(p) for p in FORBIDDEN_CHILD_ENV_PREFIXES
        ):
            raise RuntimeError(f"codex child env allowlist must not include forbidden key {key!r}")
    child[mcp_env_var] = token
    if "PATH" not in child:
        raise RuntimeError("codex child env requires PATH")
    if "HOME" not in child:
        raise RuntimeError("codex child env requires HOME")
    return child
