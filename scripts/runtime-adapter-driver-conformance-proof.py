#!/usr/bin/env python3
"""Offline behavioral proofs for runtime-adapter/v1 (not source-string greps).

Exercises:
  1. attach/signature failure is TERMINAL before presence or dispatch
  2. codex child env is allowlisted (no GitHub/cloud/deploy creds)
  3. detach + inbox domains are implemented (canonical bytes + call paths)

Invoked by scripts/runtime-adapter-driver-conformance.mjs.
"""
from __future__ import annotations

import sys
import traceback
from pathlib import Path
from typing import Any
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))

from runtime_adapter_v1 import (  # noqa: E402
    SIGNED_ATTACH_DOMAIN,
    SIGNED_DETACH_DOMAIN,
    SIGNED_INBOX_DOMAIN,
    AdapterConfig,
    RuntimeIdentity,
    attach,
    boot_session,
    bearer_detach,
    canonical_attach_message,
    canonical_detach_message,
    canonical_inbox_message,
    detach,
    signed_detach,
    signed_inbox,
)
from codex_child_env import (  # noqa: E402
    build_codex_child_env,
    resolve_sandbox,
)


def fail(name: str, detail: str) -> None:
    print(f"FAIL  {name} — {detail}")
    raise SystemExit(1)


def ok(name: str, detail: str = "") -> None:
    print(f"PASS  {name}{f' — {detail}' if detail else ''}")


def _cfg(*, key_path: Path | None = None) -> AdapterConfig:
    return AdapterConfig(
        mcp_url="https://example.test/mcp",
        api_base_url="https://example.test",
        token="tok-test",
        runtime="codex",
        agent_type="builder",
        lifecycle="on_demand",
        user_agent="conformance-proof/1.0",
        gate_owner="gate:kasra-core",
        key_path=key_path,
    )


def _identity() -> RuntimeIdentity:
    return RuntimeIdentity(
        tenant="tenant-a",
        member_id="member-a",
        agent_id="agent-a",
        capabilities=(),
        identity_status="minted",
        slug="codex",
        squad_id="squad-core",
    )


def proof_attach_fail_closed() -> None:
    """Attach failure must raise before presence_register / return."""
    cfg = _cfg()
    identity = _identity()
    logs: list[str] = []
    presence_calls: list[Any] = []

    def fake_resolve(_cfg: AdapterConfig) -> RuntimeIdentity:
        return identity

    def fake_attach(_cfg: AdapterConfig, _id: RuntimeIdentity, *, host: str = "") -> dict[str, Any]:
        raise RuntimeError("attach-signed failed HTTP 401: {'error': 'unauthorized'}")

    def fake_presence(cfg: AdapterConfig, *, adapter: str, log: Any) -> None:
        presence_calls.append(adapter)
        log(f"presence would register {adapter}")

    with (
        patch("runtime_adapter_v1.resolve_identity", fake_resolve),
        patch("runtime_adapter_v1.attach", fake_attach),
        patch("runtime_adapter_v1.register_port1_presence", fake_presence),
    ):
        raised: Exception | None = None
        try:
            boot_session(cfg, presence_adapter="codex", log=logs.append)
        except Exception as exc:  # noqa: BLE001 - under test
            raised = exc

    if raised is None:
        fail("attach fail-closed", "boot_session returned despite attach failure")
    if "401" not in str(raised) and "unauthorized" not in str(raised).lower():
        fail("attach fail-closed", f"unexpected error: {raised}")
    if presence_calls:
        fail("attach fail-closed", f"presence ran after attach failure: {presence_calls}")
    if any("non-fatal" in line for line in logs):
        fail("attach fail-closed", "logs still treat attach failure as non-fatal")
    ok("attach fail-closed", "boot_session raised; presence not called")


def proof_signed_attach_bad_sig_path() -> None:
    """signed_attach surfaces HTTP 401 — callers must not swallow it."""
    cfg = _cfg(key_path=Path("/nonexistent/key.jwk"))
    # Force the signed path by pretending the key file exists + loading a fake key,
    # then returning 401 from HTTP — proves signature-failure shape is terminal.
    identity = _identity()

    class _FakeKey:
        def sign(self, message: bytes) -> bytes:
            return b"\x00" * 64

    with (
        patch("runtime_adapter_v1.Path.is_file", return_value=True),
        patch("runtime_adapter_v1._load_ed25519_private_key", return_value=_FakeKey()),
        patch(
            "runtime_adapter_v1._http_json",
            return_value=(401, {"ok": False, "error": "unauthorized"}),
        ),
    ):
        try:
            attach(cfg, identity)
            fail("signed attach bad-sig raises", "attach did not raise on HTTP 401")
        except RuntimeError as exc:
            if "401" not in str(exc):
                fail("signed attach bad-sig raises", f"wrong error: {exc}")
            ok("signed attach bad-sig raises", "HTTP 401 → RuntimeError")


def proof_child_env_scrub() -> None:
    parent = {
        "PATH": "/usr/bin",
        "HOME": "/home/agent",
        "LANG": "C.UTF-8",
        "GITHUB_TOKEN": "ghp_secret",
        "GH_TOKEN": "gh_secret",
        "AWS_SECRET_ACCESS_KEY": "aws_secret",
        "CLOUDFLARE_API_TOKEN": "cf_secret",
        "CF_API_TOKEN": "cf_secret2",
        "DEPLOY_KEY": "deploy_secret",
        "WRANGLER_SEND_METRICS": "false",
        "NPM_TOKEN": "npm_secret",
        "NODE_AUTH_TOKEN": "node_secret",
        "MUPOT_MCP_TOKEN": "should-not-inherit-from-parent",
        "SECRET_MISC": "still-not-copied",
    }
    child = build_codex_child_env(parent, mcp_env_var="MUPOT_MCP_TOKEN", token="mcp-only-token")
    forbidden = [
        "GITHUB_TOKEN",
        "GH_TOKEN",
        "AWS_SECRET_ACCESS_KEY",
        "CLOUDFLARE_API_TOKEN",
        "CF_API_TOKEN",
        "DEPLOY_KEY",
        "WRANGLER_SEND_METRICS",
        "NPM_TOKEN",
        "NODE_AUTH_TOKEN",
        "SECRET_MISC",
    ]
    leaked = [k for k in forbidden if k in child]
    if leaked:
        fail("codex child env scrub", f"leaked keys: {leaked}")
    if child.get("MUPOT_MCP_TOKEN") != "mcp-only-token":
        fail("codex child env scrub", "MCP token not set to the task token")
    if child.get("PATH") != "/usr/bin" or child.get("HOME") != "/home/agent":
        fail("codex child env scrub", "PATH/HOME missing from allowlist copy")
    if set(child.keys()) - {"PATH", "HOME", "LANG", "MUPOT_MCP_TOKEN"}:
        # LANG is optional allowlisted; anything else is unexpected here
        extra = set(child.keys()) - {"PATH", "HOME", "LANG", "MUPOT_MCP_TOKEN"}
        if extra:
            fail("codex child env scrub", f"unexpected keys: {sorted(extra)}")
    ok("codex child env scrub", f"keys={sorted(child)}")


def proof_danger_full_access_disallowed() -> None:
    try:
        resolve_sandbox("danger-full-access")
        fail("danger-full-access disallowed", "resolve_sandbox accepted danger-full-access")
    except ValueError:
        ok("danger-full-access disallowed")
    if resolve_sandbox("workspace-write") != "workspace-write":
        fail("danger-full-access disallowed", "workspace-write should remain allowed")
    if resolve_sandbox("read-only") != "read-only":
        fail("danger-full-access disallowed", "read-only should remain allowed")


def proof_detach_inbox_implemented() -> None:
    # Canonical domain bytes (contract lock).
    detach_msg = canonical_detach_message(
        tenant="t", agent_id="a", ts=1, nonce="n"
    ).decode("utf-8")
    inbox_msg = canonical_inbox_message(
        tenant="t", agent_id="a", peek=True, limit=20, ts=1, nonce="n"
    ).decode("utf-8")
    attach_msg = canonical_attach_message(
        tenant="t",
        agent_id="a",
        agent_type="builder",
        runtime="codex",
        lifecycle="on_demand",
        ts=1,
        nonce="n",
    ).decode("utf-8")
    if not detach_msg.startswith(SIGNED_DETACH_DOMAIN + "\n"):
        fail("detach domain implemented", detach_msg)
    if not inbox_msg.startswith(SIGNED_INBOX_DOMAIN + "\n"):
        fail("inbox domain implemented", inbox_msg)
    if not attach_msg.startswith(SIGNED_ATTACH_DOMAIN + "\n"):
        fail("attach domain implemented", attach_msg)

    cfg = _cfg(key_path=Path("/tmp/fake.key"))
    identity = _identity()

    class _FakeKey:
        def sign(self, message: bytes) -> bytes:
            return b"\x11" * 64

    http_calls: list[str] = []

    def fake_http(method: str, url: str, **_kwargs: Any) -> tuple[int, dict[str, Any]]:
        http_calls.append(f"{method} {url}")
        return 200, {"ok": True, "messages": []}

    with (
        patch("runtime_adapter_v1.Path.is_file", return_value=True),
        patch("runtime_adapter_v1._load_ed25519_private_key", return_value=_FakeKey()),
        patch("runtime_adapter_v1._http_json", side_effect=fake_http),
    ):
        signed_detach(cfg, identity)
        signed_inbox(cfg, identity, peek=True, limit=10)
        # detach() prefers signed when key exists
        detach(cfg, identity)

    # bearer detach path (no key)
    cfg_bearer = _cfg(key_path=None)
    with patch("runtime_adapter_v1._http_json", side_effect=fake_http):
        bearer_detach(cfg_bearer, identity)

    needed = [
        "/api/fleet/detach-signed",
        "/api/inbox/signed",
        "/api/fleet/detach",
    ]
    joined = " | ".join(http_calls)
    missing = [p for p in needed if p not in joined]
    if missing:
        fail("detach/inbox call paths", f"missing {missing}; calls={http_calls}")
    ok("detach/inbox implemented", f"calls={len(http_calls)}")


def main() -> int:
    proofs = [
        proof_attach_fail_closed,
        proof_signed_attach_bad_sig_path,
        proof_child_env_scrub,
        proof_danger_full_access_disallowed,
        proof_detach_inbox_implemented,
    ]
    for proof in proofs:
        try:
            proof()
        except SystemExit:
            raise
        except Exception:  # noqa: BLE001
            traceback.print_exc()
            fail(proof.__name__, "unhandled exception")
    print("")
    print(f"runtime-adapter driver behavioral proofs: {len(proofs)}/{len(proofs)} passed")
    return 0


if __name__ == "__main__":
    # Import helper: keep build_codex_child_env importable without pulling argparse
    # side effects from codex-worker at module load. Re-export via thin shim module.
    raise SystemExit(main())
