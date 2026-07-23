#!/usr/bin/env python3
"""runtime-adapter/v1 — shared reference client for topology-A drivers.

Contract: docs/runtime-adapter-contract.md + docs/runtime-adapter-v1.json

This is the REFERENCE adapter every later harness copies. Drivers (cursor,
mumcp/claude-code, codex, …) import this module instead of hand-rolling
MCP/attach/land-at-review glue. Identity, tenant, and capabilities are ALWAYS
server-derived (boot_context / attach ack) — local config is input for proof,
never authority.

Hard rails (non-negotiable):
  - land work at status=review behind gate_owner
  - never merge / deploy / publish / self-verdict
  - declare a contract runtime type on attach
  - signed attach uses domain fleet-attach:v1 (when a host key exists)
"""
from __future__ import annotations

import base64
import json
import os
import secrets
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping

CONTRACT_ID = "runtime-adapter/v1"
SIGNED_ATTACH_DOMAIN = "fleet-attach:v1"
SIGNED_DETACH_DOMAIN = "fleet-detach:v1"
SIGNED_INBOX_DOMAIN = "agent-inbox:v1"
LAND_AT_STATUS = "review"
ATTACH_PATH = "/api/fleet/attach"
ATTACH_SIGNED_PATH = "/api/fleet/attach-signed"
DETACH_PATH = "/api/fleet/detach"
DETACH_SIGNED_PATH = "/api/fleet/detach-signed"
LIFECYCLES = frozenset({"on_demand", "always_on"})
# Adapter arms never take these actions — the gate / human does.
FORBIDDEN_ADAPTER_ACTIONS = frozenset({"merge", "deploy", "publish", "self_verdict", "approve"})


@dataclass(frozen=True)
class RuntimeIdentity:
    """Server-derived principal. Never construct from local env as authority."""

    tenant: str
    member_id: str
    agent_id: str
    capabilities: tuple[Mapping[str, Any], ...]
    identity_status: str
    slug: str | None
    squad_id: str | None


@dataclass(frozen=True)
class AdapterConfig:
    mcp_url: str
    api_base_url: str
    token: str
    runtime: str
    agent_type: str
    lifecycle: str
    user_agent: str
    gate_owner: str
    key_path: Path | None


LogFn = Callable[[str], None]


def api_base_from_mcp(mcp_url: str) -> str:
    """Derive the pot HTTP base from the MCP endpoint URL."""
    base = mcp_url.rstrip("/")
    if base.endswith("/mcp"):
        return base[: -len("/mcp")]
    return base


def read_token(token_path: Path) -> str:
    token = token_path.read_text().strip()
    if not token:
        raise ValueError(f"empty token at {token_path}")
    return token


def _http_json(
    method: str,
    url: str,
    *,
    headers: Mapping[str, str],
    body: Mapping[str, Any] | None,
    timeout: float,
) -> tuple[int, dict[str, Any]]:
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers=dict(headers), method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            payload: dict[str, Any] = json.loads(raw) if raw else {}
            return int(resp.status), payload
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            payload = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            payload = {"raw": raw.decode("utf-8", errors="replace")}
        return int(exc.code), payload


def mcp_call(cfg: AdapterConfig, tool: str, args: Mapping[str, Any], *, timeout: float = 60.0) -> dict[str, Any]:
    """Call a mupot MCP tool. Returns the tool's `result` object."""
    status, payload = _http_json(
        "POST",
        cfg.mcp_url,
        headers={
            "Authorization": f"Bearer {cfg.token}",
            "content-type": "application/json",
            "User-Agent": cfg.user_agent,
        },
        body={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": tool, "arguments": dict(args)},
        },
        timeout=timeout,
    )
    if status >= 400:
        raise RuntimeError(f"mupot {tool} HTTP {status}: {payload}")
    if "error" in payload:
        raise RuntimeError(f"mupot {tool} error: {payload['error']}")
    try:
        inner = json.loads(payload["result"]["content"][0]["text"])
    except (KeyError, IndexError, TypeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"mupot {tool} malformed response: {exc}") from exc
    if not inner.get("ok", True):
        raise RuntimeError(f"mupot {tool} not ok: {inner}")
    result = inner.get("result", inner)
    if not isinstance(result, dict):
        raise RuntimeError(f"mupot {tool} result is not an object: {type(result).__name__}")
    return result


def resolve_identity(cfg: AdapterConfig) -> RuntimeIdentity:
    """Derive tenant/member/agent/capabilities from the server (boot_context + orient).

    Local env AGENT_ID / TENANT are NEVER accepted as authority.
    """
    boot = mcp_call(cfg, "boot_context", {})
    tenant = boot.get("tenant")
    member_id = boot.get("member_id")
    agent_id = boot.get("bound_agent_id")
    identity_status = boot.get("identity_status")
    caps_raw = boot.get("capabilities") or []
    if not isinstance(tenant, str) or not tenant:
        raise RuntimeError("boot_context missing server-derived tenant")
    if not isinstance(member_id, str) or not member_id:
        raise RuntimeError("boot_context missing server-derived member_id")
    if identity_status != "minted" or not isinstance(agent_id, str) or not agent_id:
        raise RuntimeError(
            f"runtime-adapter/v1 requires a minted agent-bound token; "
            f"got identity_status={identity_status!r} bound_agent_id={agent_id!r}"
        )
    if not isinstance(caps_raw, list):
        raise RuntimeError("boot_context capabilities must be a list")

    slug: str | None = None
    squad_id: str | None = None
    orient = mcp_call(cfg, "orient", {})
    packet = orient.get("packet") if isinstance(orient.get("packet"), dict) else orient
    agent = packet.get("agent") if isinstance(packet, dict) else None
    squad = packet.get("squad") if isinstance(packet, dict) else None
    if isinstance(agent, dict) and isinstance(agent.get("slug"), str):
        slug = agent["slug"]
    if isinstance(squad, dict) and isinstance(squad.get("id"), str):
        squad_id = squad["id"]
    if squad_id is None:
        for cap in caps_raw:
            if (
                isinstance(cap, dict)
                and cap.get("scope_type") == "squad"
                and isinstance(cap.get("scope_id"), str)
            ):
                squad_id = cap["scope_id"]
                break

    return RuntimeIdentity(
        tenant=tenant,
        member_id=member_id,
        agent_id=agent_id,
        capabilities=tuple(c for c in caps_raw if isinstance(c, Mapping)),
        identity_status=identity_status,
        slug=slug,
        squad_id=squad_id,
    )


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _load_ed25519_private_key(key_path: Path) -> Any:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives.serialization import load_pem_private_key

    raw = key_path.read_bytes()
    # Prefer JWK (fleet-runtime agent-keygen shape); fall back to PEM.
    try:
        jwk = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        jwk = None
    if isinstance(jwk, dict) and jwk.get("kty") == "OKP" and jwk.get("crv") == "Ed25519":
        d = jwk.get("d")
        if not isinstance(d, str) or not d:
            raise ValueError(f"Ed25519 JWK at {key_path} missing d")
        pad = "=" * (-len(d) % 4)
        seed = base64.urlsafe_b64decode(d + pad)
        return Ed25519PrivateKey.from_private_bytes(seed)
    key = load_pem_private_key(raw, password=None)
    if not isinstance(key, Ed25519PrivateKey):
        raise TypeError(f"key at {key_path} is not Ed25519")
    return key


def canonical_attach_message(
    *,
    tenant: str,
    agent_id: str,
    agent_type: str,
    runtime: str,
    lifecycle: str,
    ts: int,
    nonce: str,
) -> bytes:
    """Byte-identical to src/fleet/signed-attach.ts / fleet-runtime/fleet-sign.mjs."""
    return "\n".join(
        [
            SIGNED_ATTACH_DOMAIN,
            tenant,
            agent_id,
            agent_type,
            runtime,
            lifecycle,
            str(ts),
            nonce,
        ]
    ).encode("utf-8")


def signed_attach(
    cfg: AdapterConfig,
    identity: RuntimeIdentity,
    *,
    host: str = "",
    timeout: float = 30.0,
) -> dict[str, Any]:
    """POST /api/fleet/attach-signed with fleet-attach:v1 domain separation."""
    if cfg.key_path is None or not cfg.key_path.is_file():
        raise FileNotFoundError("signed_attach requires AdapterConfig.key_path")
    if cfg.lifecycle not in LIFECYCLES:
        raise ValueError(f"lifecycle must be one of {sorted(LIFECYCLES)}")
    priv = _load_ed25519_private_key(cfg.key_path)
    ts = int(time.time())
    nonce = _b64url(secrets.token_bytes(32))
    message = canonical_attach_message(
        tenant=identity.tenant,
        agent_id=identity.agent_id,
        agent_type=cfg.agent_type,
        runtime=cfg.runtime,
        lifecycle=cfg.lifecycle,
        ts=ts,
        nonce=nonce,
    )
    sig = _b64url(priv.sign(message))
    body: dict[str, Any] = {
        "agent_id": identity.agent_id,
        "type": cfg.agent_type,
        "runtime": cfg.runtime,
        "lifecycle": cfg.lifecycle,
        "ts": ts,
        "nonce": nonce,
        "sig": sig,
        "host": host if isinstance(host, str) else "",
    }
    status, payload = _http_json(
        "POST",
        f"{cfg.api_base_url.rstrip('/')}{ATTACH_SIGNED_PATH}",
        headers={"content-type": "application/json", "User-Agent": cfg.user_agent},
        body=body,
        timeout=timeout,
    )
    if status >= 400 or not payload.get("ok", False):
        raise RuntimeError(f"attach-signed failed HTTP {status}: {payload}")
    return payload


def bearer_attach(
    cfg: AdapterConfig,
    identity: RuntimeIdentity,
    *,
    host: str = "",
    timeout: float = 30.0,
) -> dict[str, Any]:
    """POST /api/fleet/attach — token-welded agents without a registered key."""
    if cfg.lifecycle not in LIFECYCLES:
        raise ValueError(f"lifecycle must be one of {sorted(LIFECYCLES)}")
    body: dict[str, Any] = {
        "agent_id": identity.agent_id,
        "type": cfg.agent_type,
        "runtime": cfg.runtime,
        "lifecycle": cfg.lifecycle,
        "host": host if isinstance(host, str) else "",
    }
    status, payload = _http_json(
        "POST",
        f"{cfg.api_base_url.rstrip('/')}{ATTACH_PATH}",
        headers={
            "Authorization": f"Bearer {cfg.token}",
            "content-type": "application/json",
            "User-Agent": cfg.user_agent,
        },
        body=body,
        timeout=timeout,
    )
    if status >= 400 or not payload.get("ok", False):
        raise RuntimeError(f"bearer attach failed HTTP {status}: {payload}")
    return payload


def attach(cfg: AdapterConfig, identity: RuntimeIdentity, *, host: str = "") -> dict[str, Any]:
    """Prefer signed attach (fleet-attach:v1) when a host key exists; else bearer."""
    if cfg.key_path is not None and cfg.key_path.is_file():
        return signed_attach(cfg, identity, host=host)
    return bearer_attach(cfg, identity, host=host)


def canonical_detach_message(*, tenant: str, agent_id: str, ts: int, nonce: str) -> bytes:
    """Byte-identical to src/fleet/signed-detach.ts / fleet-runtime/fleet-sign.mjs."""
    return "\n".join(
        [SIGNED_DETACH_DOMAIN, tenant, agent_id, str(ts), nonce]
    ).encode("utf-8")


def canonical_inbox_message(
    *,
    tenant: str,
    agent_id: str,
    peek: bool,
    limit: int,
    ts: int,
    nonce: str,
) -> bytes:
    """Byte-identical to src/fleet/signed-inbox.ts / fleet-runtime/fleet-sign.mjs."""
    return "\n".join(
        [
            SIGNED_INBOX_DOMAIN,
            tenant,
            agent_id,
            "1" if peek else "0",
            str(limit),
            str(ts),
            nonce,
        ]
    ).encode("utf-8")


def signed_detach(
    cfg: AdapterConfig,
    identity: RuntimeIdentity,
    *,
    timeout: float = 30.0,
) -> dict[str, Any]:
    """POST /api/fleet/detach-signed with fleet-detach:v1 domain separation."""
    if cfg.key_path is None or not cfg.key_path.is_file():
        raise FileNotFoundError("signed_detach requires AdapterConfig.key_path")
    priv = _load_ed25519_private_key(cfg.key_path)
    ts = int(time.time())
    nonce = _b64url(secrets.token_bytes(32))
    message = canonical_detach_message(
        tenant=identity.tenant,
        agent_id=identity.agent_id,
        ts=ts,
        nonce=nonce,
    )
    sig = _b64url(priv.sign(message))
    body: dict[str, Any] = {
        "agent_id": identity.agent_id,
        "ts": ts,
        "nonce": nonce,
        "sig": sig,
    }
    status, payload = _http_json(
        "POST",
        f"{cfg.api_base_url.rstrip('/')}{DETACH_SIGNED_PATH}",
        headers={"content-type": "application/json", "User-Agent": cfg.user_agent},
        body=body,
        timeout=timeout,
    )
    if status >= 400 or not payload.get("ok", False):
        raise RuntimeError(f"detach-signed failed HTTP {status}: {payload}")
    return payload


def bearer_detach(
    cfg: AdapterConfig,
    identity: RuntimeIdentity,
    *,
    timeout: float = 30.0,
) -> dict[str, Any]:
    """POST /api/fleet/detach — token-welded agents without a registered key."""
    body: dict[str, Any] = {"agent_id": identity.agent_id}
    status, payload = _http_json(
        "POST",
        f"{cfg.api_base_url.rstrip('/')}{DETACH_PATH}",
        headers={
            "Authorization": f"Bearer {cfg.token}",
            "content-type": "application/json",
            "User-Agent": cfg.user_agent,
        },
        body=body,
        timeout=timeout,
    )
    if status >= 400 or not payload.get("ok", False):
        raise RuntimeError(f"bearer detach failed HTTP {status}: {payload}")
    return payload


def detach(cfg: AdapterConfig, identity: RuntimeIdentity) -> dict[str, Any]:
    """Prefer signed detach (fleet-detach:v1) when a host key exists; else bearer."""
    if cfg.key_path is not None and cfg.key_path.is_file():
        return signed_detach(cfg, identity)
    return bearer_detach(cfg, identity)


def signed_inbox(
    cfg: AdapterConfig,
    identity: RuntimeIdentity,
    *,
    peek: bool,
    limit: int,
    timeout: float = 30.0,
) -> dict[str, Any]:
    """POST /api/inbox/signed with agent-inbox:v1 domain separation."""
    if cfg.key_path is None or not cfg.key_path.is_file():
        raise FileNotFoundError("signed_inbox requires AdapterConfig.key_path")
    if not isinstance(limit, int) or limit < 1 or limit > 100:
        raise ValueError("signed_inbox limit must be an integer 1-100")
    priv = _load_ed25519_private_key(cfg.key_path)
    ts = int(time.time())
    nonce = _b64url(secrets.token_bytes(32))
    message = canonical_inbox_message(
        tenant=identity.tenant,
        agent_id=identity.agent_id,
        peek=peek,
        limit=limit,
        ts=ts,
        nonce=nonce,
    )
    sig = _b64url(priv.sign(message))
    body: dict[str, Any] = {
        "agent_id": identity.agent_id,
        "peek": peek,
        "limit": limit,
        "ts": ts,
        "nonce": nonce,
        "sig": sig,
    }
    status, payload = _http_json(
        "POST",
        f"{cfg.api_base_url.rstrip('/')}/api/inbox/signed",
        headers={"content-type": "application/json", "User-Agent": cfg.user_agent},
        body=body,
        timeout=timeout,
    )
    if status >= 400:
        raise RuntimeError(f"signed inbox failed HTTP {status}: {payload}")
    return payload


def land_at_review(
    cfg: AdapterConfig,
    *,
    task_id: str,
    body: str,
    gate_owner: str | None = None,
) -> dict[str, Any]:
    """Land work at status=review. Adapters never merge/deploy/self-verdict."""
    owner = gate_owner if gate_owner is not None else cfg.gate_owner
    return mcp_call(
        cfg,
        "task_update",
        {
            "task_id": task_id,
            "status": LAND_AT_STATUS,
            "gate_owner": owner,
            "body": body,
        },
    )


def report_blocked(cfg: AdapterConfig, *, task_id: str, body: str) -> dict[str, Any]:
    return mcp_call(cfg, "task_update", {"task_id": task_id, "status": "blocked", "body": body})


def claim_in_progress(cfg: AdapterConfig, *, task_id: str) -> dict[str, Any]:
    return mcp_call(cfg, "task_update", {"task_id": task_id, "status": "in_progress"})


def poll_open_tasks(
    cfg: AdapterConfig,
    identity: RuntimeIdentity,
    *,
    limit: int,
    squad_id: str | None = None,
) -> list[dict[str, Any]]:
    """Own-assignee filter only — server-derived agent_id, never a local guess."""
    args: dict[str, Any] = {
        "assignee_agent_id": identity.agent_id,
        "status": "open",
        "limit": limit,
    }
    if squad_id:
        args["squad_id"] = squad_id
    res = mcp_call(cfg, "task_list", args)
    tasks = res.get("tasks", [])
    if not isinstance(tasks, list):
        raise RuntimeError("task_list.tasks must be a list")
    return [t for t in tasks if isinstance(t, dict)][:limit]


def register_port1_presence(
    cfg: AdapterConfig,
    *,
    adapter: str,
    log: LogFn,
) -> None:
    """Best-effort Port-1 self-registration (concierge dispatcher). Non-fatal.

    Capabilities are NEVER client-asserted — the pot derives them server-side
    from the bound agent / fleet agent_type. The driver only names its adapter.
    """
    try:
        mcp_call(
            cfg,
            "presence_register",
            {
                "adapter": adapter,
                "kind": "agent_system",
                "project_id": None,
            },
        )
        log(f"presence: registered/refreshed (adapter={adapter}; capabilities server-derived)")
    except Exception as exc:  # noqa: BLE001 - presence is best-effort, never fatal
        log(f"presence_register failed (non-fatal): {exc}")


def boot_session(
    cfg: AdapterConfig,
    *,
    presence_adapter: str,
    log: LogFn,
    host: str = "",
) -> RuntimeIdentity:
    """Resolve identity (server) → attach (fail-closed) → Port-1 presence (soft).

    Attach / signature verification failure is TERMINAL: no presence, no poll,
    no claim, no dispatch. Only presence-registration transient errors may be soft.
    """
    identity = resolve_identity(cfg)
    log(
        f"{CONTRACT_ID} identity tenant={identity.tenant} "
        f"agent={identity.agent_id} slug={identity.slug!r} "
        f"runtime={cfg.runtime} lifecycle={cfg.lifecycle}"
    )
    # Fail-closed: every attach failure (including signature verification) is terminal.
    ack = attach(cfg, identity, host=host)
    agent_view = ack.get("agent") if isinstance(ack.get("agent"), dict) else {}
    log(
        f"attach ok runtime={agent_view.get('runtime', cfg.runtime)!r} "
        f"status={agent_view.get('status', 'running')!r}"
    )
    register_port1_presence(cfg, adapter=presence_adapter, log=log)
    return identity


def config_from_env(
    *,
    token_path: Path,
    runtime: str,
    agent_type: str,
    user_agent: str,
    mcp_url: str | None = None,
    api_base_url: str | None = None,
    lifecycle: str | None = None,
    gate_owner: str | None = None,
    key_path: Path | None = None,
) -> AdapterConfig:
    mcp = mcp_url if mcp_url is not None else os.environ.get("MUPOT_MCP", "https://mupot.mumega.com/mcp")
    api = api_base_url if api_base_url is not None else os.environ.get("MUPOT_API_BASE")
    if not api:
        api = api_base_from_mcp(mcp)
    life = lifecycle if lifecycle is not None else os.environ.get("LIFECYCLE", "on_demand")
    if life not in LIFECYCLES:
        raise ValueError(f"lifecycle must be one of {sorted(LIFECYCLES)}, got {life!r}")
    gate = gate_owner if gate_owner is not None else os.environ.get("GATE_OWNER", "gate:kasra-core")
    return AdapterConfig(
        mcp_url=mcp,
        api_base_url=api,
        token=read_token(token_path),
        runtime=runtime,
        agent_type=agent_type,
        lifecycle=life,
        user_agent=user_agent,
        gate_owner=gate,
        key_path=key_path,
    )
