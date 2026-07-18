"""Restricted Mupot operator tools for an on-demand Hermes runtime.

This module deliberately does not expose Mupot's generic MCP catalog.  It maps a
small set of Hermes tools to fixed Mupot Actions endpoints, injects the configured
DME squad and Hermes identity, and fails closed when the bearer token is not
welded to that identity or carries owner/admin authority.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
from typing import Any, Callable, Mapping, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener


JsonObject = dict[str, Any]
Transport = Callable[[str, dict[str, str], JsonObject, float], JsonObject]

OPERATOR_ACTIONS = frozenset(
    {
        "status",
        "check_in",
        "task_board",
        "task_create",
        "task_update",
        "send",
        "inbox",
    }
)

MANAGER_LIFECYCLE_ACTIONS = frozenset(
    {
        "agent_manager_status",
        "agent_manager_list",
        "agent_manager_create",
        "agent_manager_set_status",
    }
)

MANAGER_CREDENTIAL_ACTIONS = frozenset(
    {
        "agent_manager_mint_token",
        "agent_manager_revoke_token",
    }
)

MANAGER_ACTIONS = MANAGER_LIFECYCLE_ACTIONS | MANAGER_CREDENTIAL_ACTIONS

OPERATOR_TOOL_NAMES = (
    "mupot_operator_status",
    "mupot_operator_check_in",
    "mupot_operator_task_board",
    "mupot_operator_task_create",
    "mupot_operator_task_claim",
    "mupot_operator_record_finding",
    "mupot_operator_request_approval",
    "mupot_operator_complete_task",
    "mupot_operator_send",
    "mupot_operator_inbox",
)

MANAGER_LIFECYCLE_TOOL_NAMES = (
    "mupot_agent_manager_list",
    "mupot_agent_manager_create",
    "mupot_agent_manager_set_status",
)

MANAGER_CREDENTIAL_TOOL_NAMES = (
    "mupot_agent_manager_mint_token",
    "mupot_agent_manager_revoke_token",
)

MANAGER_TOOL_NAMES = MANAGER_LIFECYCLE_TOOL_NAMES + MANAGER_CREDENTIAL_TOOL_NAMES

_SAFE_FINDING_STATUSES = frozenset({"in_progress", "blocked"})
_OVERPRIVILEGED_CAPABILITIES = frozenset({"admin", "owner"})
_MAX_RESPONSE_BYTES = 256 * 1024
_BEARER_PATTERN = re.compile(r"(?i)bearer\s+[^\s\"']+")


class PluginContextLike(Protocol):
    def register_tool(self, **kwargs: Any) -> None: ...


@dataclass(frozen=True)
class OperatorSettings:
    """Non-secret configuration for one restricted Mupot identity."""

    base_url: str
    expected_tenant: str
    squad_id: str
    agent_id: str
    approval_owner: str
    pubsub_peer_agent_ids: tuple[str, ...] = ()
    agent_manager_enabled: bool = False
    agent_manager_credentials_enabled: bool = False
    agent_manager_secret_dir: str = ""
    timeout: float = 20.0

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "OperatorSettings":
        timeout_value = value.get("timeout", 20.0)
        try:
            timeout = float(timeout_value)
        except (TypeError, ValueError) as exc:
            raise ValueError("operator timeout must be numeric") from exc
        manager_enabled = value.get("agent_manager_enabled", False)
        if not isinstance(manager_enabled, bool):
            raise ValueError("operator agent_manager_enabled must be boolean")
        credential_manager_enabled = value.get("agent_manager_credentials_enabled", False)
        if not isinstance(credential_manager_enabled, bool):
            raise ValueError("operator agent_manager_credentials_enabled must be boolean")
        raw_peers = value.get("pubsub_peer_agent_ids", [])
        if isinstance(raw_peers, str):
            raw_peers = [raw_peers]
        if not isinstance(raw_peers, (list, tuple)) or any(
            not isinstance(peer, str) or not peer.strip() for peer in raw_peers
        ):
            raise ValueError("operator pubsub_peer_agent_ids must be an agent ID or list of agent IDs")
        settings = cls(
            base_url=_required_setting(value, "base_url"),
            expected_tenant=_required_setting(value, "expected_tenant"),
            squad_id=_required_setting(value, "squad_id"),
            agent_id=_required_setting(value, "agent_id"),
            approval_owner=_required_setting(value, "approval_owner"),
            pubsub_peer_agent_ids=tuple(peer.strip() for peer in raw_peers),
            agent_manager_enabled=manager_enabled,
            agent_manager_credentials_enabled=credential_manager_enabled,
            agent_manager_secret_dir=str(value.get("agent_manager_secret_dir", "")).strip(),
            timeout=timeout,
        )
        settings.validate()
        return settings

    def validate(self) -> None:
        parsed = urlparse(self.base_url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError("operator base_url must be an absolute HTTP(S) URL")
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("operator base_url must not contain credentials, query, or fragment")
        is_loopback = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
        if parsed.scheme != "https" and not is_loopback:
            raise ValueError("operator base_url must use HTTPS except for loopback development")
        if not 1 <= self.timeout <= 120:
            raise ValueError("operator timeout must be between 1 and 120 seconds")
        for name in ("expected_tenant", "squad_id", "agent_id", "approval_owner"):
            if not getattr(self, name).strip():
                raise ValueError(f"operator {name} must not be empty")
        if len(set(self.pubsub_peer_agent_ids)) != len(self.pubsub_peer_agent_ids):
            raise ValueError("operator pubsub_peer_agent_ids must not contain duplicates")
        for peer in self.pubsub_peer_agent_ids:
            if len(peer) > 128 or not re.fullmatch(r"[A-Za-z0-9_.:-]+", peer):
                raise ValueError("operator pubsub peer agent ID is invalid")
            if peer == self.agent_id:
                raise ValueError("operator pubsub peer must not be the configured agent itself")
        if self.agent_manager_credentials_enabled:
            if not self.agent_manager_enabled:
                raise ValueError("operator credential management requires agent_manager_enabled")
            if not self.agent_manager_secret_dir:
                raise ValueError("operator agent_manager_secret_dir is required when credential management is enabled")
            if not Path(self.agent_manager_secret_dir).expanduser().is_absolute():
                raise ValueError("operator agent_manager_secret_dir must resolve to an absolute path")


class _NoRedirect(HTTPRedirectHandler):
    """Never forward an agent-bound Authorization header to another origin."""

    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        return None


def _required_setting(value: Mapping[str, Any], key: str) -> str:
    candidate = value.get(key)
    if not isinstance(candidate, str) or not candidate.strip():
        raise ValueError(f"operator {key} is required")
    return candidate.strip()


def _store_agent_token(settings: OperatorSettings, token_id: str, raw_token: str) -> Path:
    """Persist a show-once token without ever returning it to Hermes/model output."""

    if not re.fullmatch(r"[A-Za-z0-9-]{1,128}", token_id):
        raise ValueError("invalid minted token id")
    if not raw_token.startswith("mupot_") or len(raw_token) > 256:
        raise ValueError("invalid minted token value")

    directory = Path(settings.agent_manager_secret_dir).expanduser()
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError("agent manager secret directory must be a real directory")
    os.chmod(directory, 0o700)

    destination = directory / f"{token_id}.token"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(destination, flags, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(raw_token)
            handle.flush()
            os.fsync(handle.fileno())
    except BaseException:
        destination.unlink(missing_ok=True)
        raise
    os.chmod(destination, 0o600)
    return destination


def _redact(value: str, token: str) -> str:
    redacted = value.replace(token, "[REDACTED]") if token else value
    return _BEARER_PATTERN.sub("Bearer [REDACTED]", redacted)


def _urllib_transport(
    url: str,
    headers: dict[str, str],
    payload: JsonObject,
    timeout: float,
) -> JsonObject:
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    request = Request(url, data=body, headers=headers, method="POST")
    opener = build_opener(_NoRedirect())
    try:
        with opener.open(request, timeout=timeout) as response:
            raw = response.read(_MAX_RESPONSE_BYTES + 1)
            if len(raw) > _MAX_RESPONSE_BYTES:
                return {"ok": False, "error": "response_too_large"}
            decoded = json.loads(raw.decode("utf-8"))
            if not isinstance(decoded, dict):
                return {"ok": False, "error": "invalid_response"}
            return decoded
    except HTTPError as exc:
        return {"ok": False, "error": "http_error", "status": exc.code}
    except URLError as exc:
        reason = getattr(exc, "reason", "network_error")
        return {"ok": False, "error": "network_error", "detail": str(reason)[:240]}
    except (TimeoutError, json.JSONDecodeError, UnicodeDecodeError) as exc:
        return {"ok": False, "error": "invalid_response", "detail": type(exc).__name__}


class MupotOperatorClient:
    """Fail-closed client for the DME Hermes action allowlist."""

    def __init__(
        self,
        settings: OperatorSettings,
        *,
        token: str,
        transport: Transport = _urllib_transport,
    ) -> None:
        settings.validate()
        if not isinstance(token, str) or not token.strip():
            raise ValueError("MUPOT_AGENT_TOKEN is required in operator mode")
        self.settings = settings
        self._token = token.strip()
        self._transport = transport

    def call(self, action: str, args: Mapping[str, Any]) -> JsonObject:
        if action not in OPERATOR_ACTIONS and action not in MANAGER_ACTIONS:
            return {"ok": False, "error": "action_not_allowed", "action": action}
        if action in MANAGER_ACTIONS and not self.settings.agent_manager_enabled:
            return {"ok": False, "error": "action_not_allowed", "action": action}
        if action in MANAGER_CREDENTIAL_ACTIONS and not self.settings.agent_manager_credentials_enabled:
            return {"ok": False, "error": "action_not_allowed", "action": action}
        if action == "status":
            return self._invoke("status", {})

        identity = self._invoke("status", {})
        identity_error = self._validate_identity(identity)
        if identity_error is not None:
            return identity_error
        if action in MANAGER_ACTIONS:
            manager_status = self._invoke(
                "agent_manager_status", {"squad_id": self.settings.squad_id}
            )
            manager_result = manager_status.get("result")
            if (
                manager_status.get("ok") is not True
                or not isinstance(manager_result, dict)
                or manager_result.get("enabled") is not True
                or manager_result.get("surface") != "agents:manage"
                or manager_result.get("squad_id") != self.settings.squad_id
                or manager_result.get("bound_agent_id") != self.settings.agent_id
            ):
                return {"ok": False, "error": "manager_capability_missing"}
        return self._invoke(action, dict(args))

    def status(self) -> JsonObject:
        result = self._invoke("status", {})
        identity_error = self._validate_identity(result)
        return identity_error or result

    def _invoke(self, action: str, args: JsonObject) -> JsonObject:
        base_url = self.settings.base_url.rstrip("/") + "/"
        url = urljoin(base_url, f"actions/{action}")
        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {self._token}",
            "Content-Type": "application/json",
            "User-Agent": "hermes-mupot-operator/0.3",
        }
        try:
            response = self._transport(url, headers, args, self.settings.timeout)
        except Exception as exc:  # tool boundary: never crash the Hermes session
            detail = _redact(str(exc), self._token)[:240]
            return {"ok": False, "error": "transport_error", "detail": detail}
        return _sanitize_response(response, self._token)

    def _validate_identity(self, response: JsonObject) -> JsonObject | None:
        if response.get("ok") is not True:
            return response
        result = response.get("result")
        if not isinstance(result, dict):
            return {"ok": False, "error": "identity_unverifiable"}
        if result.get("tenant") != self.settings.expected_tenant:
            return {"ok": False, "error": "tenant_mismatch"}
        if result.get("bound_agent_id") != self.settings.agent_id:
            return {"ok": False, "error": "identity_mismatch"}
        if result.get("role") == "owner":
            return {"ok": False, "error": "overprivileged_identity"}
        capabilities = result.get("capabilities")
        if not isinstance(capabilities, list):
            return {"ok": False, "error": "identity_unverifiable"}
        for grant in capabilities:
            if isinstance(grant, dict) and grant.get("capability") in _OVERPRIVILEGED_CAPABILITIES:
                return {"ok": False, "error": "overprivileged_identity"}
        return None


def _sanitize_response(value: Any, token: str) -> JsonObject:
    if not isinstance(value, dict):
        return {"ok": False, "error": "invalid_response"}
    serialized = json.dumps(value, default=str)
    redacted = _redact(serialized, token)
    try:
        decoded = json.loads(redacted)
    except json.JSONDecodeError:
        return {"ok": False, "error": "invalid_response"}
    return decoded if isinstance(decoded, dict) else {"ok": False, "error": "invalid_response"}


def _text(args: Mapping[str, Any], name: str, *, required: bool = True) -> str | None:
    value = args.get(name)
    if value is None and not required:
        return None
    if not isinstance(value, str) or not value.strip():
        return None
    return value.strip()


def _json_result(value: JsonObject) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False)


def build_operator_handlers(client: MupotOperatorClient) -> dict[str, Callable[[dict[str, Any]], str]]:
    settings = client.settings

    def status(_args: dict[str, Any]) -> str:
        return _json_result(client.status())

    def check_in(args: dict[str, Any]) -> str:
        label = _text(args, "label", required=False) or "DME Operations Lead"
        return _json_result(client.call("check_in", {"source": "hermes", "label": label}))

    def publish(args: dict[str, Any]) -> str:
        to = _text(args, "to")
        body = _text(args, "body")
        request_id = _text(args, "request_id")
        if to is None or body is None or request_id is None:
            return _json_result({"ok": False, "error": "to_body_and_request_id_required"})
        if to not in settings.pubsub_peer_agent_ids:
            return _json_result({"ok": False, "error": "pubsub_peer_not_allowed"})
        if len(body) > 8000:
            return _json_result({"ok": False, "error": "body_too_large"})
        if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", request_id):
            return _json_result({"ok": False, "error": "invalid_request_id"})
        kind = _text(args, "kind", required=False) or "request"
        if kind not in {"message", "request", "ack"}:
            return _json_result({"ok": False, "error": "invalid_message_kind"})
        payload: JsonObject = {
            "to": to,
            "body": body,
            "kind": kind,
            "request_id": request_id,
        }
        in_reply_to = _text(args, "in_reply_to", required=False)
        if in_reply_to is not None:
            if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", in_reply_to):
                return _json_result({"ok": False, "error": "invalid_in_reply_to"})
            payload["in_reply_to"] = in_reply_to
        return _json_result(client.call("send", payload))

    def inbox(args: dict[str, Any]) -> str:
        limit = args.get("limit", 20)
        consume = args.get("consume", False)
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 100:
            return _json_result({"ok": False, "error": "invalid_limit"})
        if not isinstance(consume, bool):
            return _json_result({"ok": False, "error": "invalid_consume"})
        return _json_result(client.call("inbox", {"limit": limit, "peek": not consume}))

    def task_board(args: dict[str, Any]) -> str:
        limit = args.get("limit", 100)
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 250:
            return _json_result({"ok": False, "error": "invalid_limit"})
        return _json_result(
            client.call("task_board", {"squad_id": settings.squad_id, "limit": limit})
        )

    def task_create(args: dict[str, Any]) -> str:
        title = _text(args, "title")
        done_when = _text(args, "done_when")
        if title is None or done_when is None:
            return _json_result({"ok": False, "error": "title_and_done_when_required"})
        payload: JsonObject = {
            "squad_id": settings.squad_id,
            "assignee_agent_id": settings.agent_id,
            "title": title,
            "done_when": done_when,
        }
        body = _text(args, "body", required=False)
        if body is not None:
            payload["body"] = body
        return _json_result(client.call("task_create", payload))

    def task_claim(args: dict[str, Any]) -> str:
        task_id = _text(args, "task_id")
        if task_id is None:
            return _json_result({"ok": False, "error": "task_id_required"})
        return _json_result(
            client.call(
                "task_update",
                {
                    "squad_id": settings.squad_id,
                    "task_id": task_id,
                    "assignee_agent_id": settings.agent_id,
                    "status": "in_progress",
                },
            )
        )

    def record_finding(args: dict[str, Any]) -> str:
        task_id = _text(args, "task_id")
        body = _text(args, "body")
        status_value = args.get("status", "in_progress")
        if status_value not in _SAFE_FINDING_STATUSES:
            return _json_result(
                {"ok": False, "error": "status_not_allowed", "status": status_value}
            )
        if task_id is None or body is None:
            return _json_result({"ok": False, "error": "task_id_and_body_required"})
        payload: JsonObject = {
            "squad_id": settings.squad_id,
            "task_id": task_id,
            "body": body,
        }
        # A finding normally follows claim, so replaying in_progress would ask
        # Mupot for an invalid in_progress -> in_progress transition. Only send
        # a status when the finding deliberately blocks the task.
        if status_value == "blocked":
            payload["status"] = status_value
        return _json_result(client.call("task_update", payload))

    def request_approval(args: dict[str, Any]) -> str:
        task_id = _text(args, "task_id")
        body = _text(args, "body")
        if task_id is None or body is None:
            return _json_result({"ok": False, "error": "task_id_and_body_required"})
        return _json_result(
            client.call(
                "task_update",
                {
                    "squad_id": settings.squad_id,
                    "task_id": task_id,
                    "body": body,
                    "gate_owner": settings.approval_owner,
                    "status": "review",
                },
            )
        )

    def complete_task(args: dict[str, Any]) -> str:
        task_id = _text(args, "task_id")
        if task_id is None:
            return _json_result({"ok": False, "error": "task_id_required"})
        payload: JsonObject = {
            "squad_id": settings.squad_id,
            "task_id": task_id,
            "status": "done",
        }
        body = _text(args, "body", required=False)
        if body is not None:
            payload["body"] = body
        return _json_result(client.call("task_update", payload))

    def manager_list(_args: dict[str, Any]) -> str:
        return _json_result(
            client.call("agent_manager_list", {"squad_id": settings.squad_id})
        )

    def manager_create(args: dict[str, Any]) -> str:
        slug = _text(args, "slug")
        name = _text(args, "name")
        if slug is None or name is None:
            return _json_result({"ok": False, "error": "slug_and_name_required"})
        payload: JsonObject = {
            "squad_id": settings.squad_id,
            "slug": slug,
            "name": name,
        }
        model = _text(args, "model", required=False)
        if model is not None:
            payload["model"] = model
        return _json_result(client.call("agent_manager_create", payload))

    def manager_set_status(args: dict[str, Any]) -> str:
        agent_id = _text(args, "agent_id")
        status_value = args.get("status")
        if agent_id is None:
            return _json_result({"ok": False, "error": "agent_id_required"})
        if status_value not in {"active", "paused"}:
            return _json_result({"ok": False, "error": "invalid_status"})
        return _json_result(
            client.call(
                "agent_manager_set_status",
                {
                    "squad_id": settings.squad_id,
                    "agent_id": agent_id,
                    "status": status_value,
                },
            )
        )

    def manager_mint_token(args: dict[str, Any]) -> str:
        agent_id = _text(args, "agent_id")
        operation_id = _text(args, "operation_id")
        if agent_id is None or operation_id is None:
            return _json_result({"ok": False, "error": "agent_id_and_operation_id_required"})
        if not re.fullmatch(r"[A-Za-z0-9_.:-]{8,128}", operation_id):
            return _json_result({"ok": False, "error": "invalid_operation_id"})
        payload: JsonObject = {
            "squad_id": settings.squad_id,
            "agent_id": agent_id,
            "request_id": operation_id,
        }
        label = _text(args, "label", required=False)
        if label is not None:
            payload["label"] = label

        response = client.call("agent_manager_mint_token", payload)
        if not response.get("ok"):
            return _json_result(response)
        result = response.get("result")
        if not isinstance(result, dict):
            return _json_result({"ok": False, "error": "invalid_mint_response"})
        token = result.get("token")
        if not isinstance(token, dict):
            return _json_result({"ok": False, "error": "invalid_mint_response"})
        token_id = token.get("id")
        raw_token = token.pop("raw", None)
        if result.get("replayed") is True:
            return _json_result(
                {
                    "ok": False,
                    "error": "mint_replayed_secret_unavailable",
                    "token_id": token_id if isinstance(token_id, str) else None,
                    "replayed": True,
                }
            )
        if not isinstance(token_id, str) or not isinstance(raw_token, str):
            return _json_result({"ok": False, "error": "invalid_mint_response"})

        try:
            secret_path = _store_agent_token(settings, token_id, raw_token)
        except (OSError, ValueError) as exc:
            revoke = client.call(
                "agent_manager_revoke_token",
                {"squad_id": settings.squad_id, "token_id": token_id},
            )
            return _json_result(
                {
                    "ok": False,
                    "error": "secret_persistence_failed",
                    "detail": type(exc).__name__,
                    "token_id": token_id,
                    "revoked": bool(revoke.get("ok")),
                }
            )

        token["secret_ref"] = str(secret_path)
        result["note"] = "plaintext stored locally with mode 0600; it was not returned to Hermes output"
        return _json_result(response)

    def manager_revoke_token(args: dict[str, Any]) -> str:
        token_id = _text(args, "token_id")
        if token_id is None:
            return _json_result({"ok": False, "error": "token_id_required"})
        return _json_result(
            client.call(
                "agent_manager_revoke_token",
                {"squad_id": settings.squad_id, "token_id": token_id},
            )
        )

    return {
        "mupot_operator_status": status,
        "mupot_operator_check_in": check_in,
        "mupot_operator_send": publish,
        "mupot_operator_inbox": inbox,
        "mupot_operator_task_board": task_board,
        "mupot_operator_task_create": task_create,
        "mupot_operator_task_claim": task_claim,
        "mupot_operator_record_finding": record_finding,
        "mupot_operator_request_approval": request_approval,
        "mupot_operator_complete_task": complete_task,
        "mupot_agent_manager_list": manager_list,
        "mupot_agent_manager_create": manager_create,
        "mupot_agent_manager_set_status": manager_set_status,
        "mupot_agent_manager_mint_token": manager_mint_token,
        "mupot_agent_manager_revoke_token": manager_revoke_token,
    }


def _object_schema(properties: JsonObject, required: list[str] | None = None) -> JsonObject:
    schema: JsonObject = {
        "type": "object",
        "properties": properties,
        "additionalProperties": False,
    }
    if required:
        schema["required"] = required
    return schema


_TOOL_DEFINITIONS: dict[str, tuple[str, JsonObject]] = {
    "mupot_operator_status": (
        "Verify the configured restricted Hermes identity and show its Mupot status.",
        _object_schema({}),
    ),
    "mupot_operator_check_in": (
        "Record that the on-demand Hermes DME operator is online.",
        _object_schema({"label": {"type": "string", "maxLength": 120}}),
    ),
    "mupot_operator_send": (
        "Publish a durable message to one explicitly configured peer agent. Sender identity is welded to the bearer token.",
        _object_schema(
            {
                "to": {"type": "string", "maxLength": 128},
                "body": {"type": "string", "maxLength": 8000},
                "kind": {"type": "string", "enum": ["message", "request", "ack"]},
                "request_id": {"type": "string", "maxLength": 128},
                "in_reply_to": {"type": "string", "maxLength": 128},
            },
            ["to", "body", "request_id"],
        ),
    ),
    "mupot_operator_inbox": (
        "Read this agent's durable Mupot inbox. Peeks by default; set consume only after accepting the messages.",
        _object_schema(
            {
                "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                "consume": {"type": "boolean"},
            }
        ),
    ),
    "mupot_operator_task_board": (
        "Read the configured DME squad task board. The squad scope is fixed by configuration.",
        _object_schema({"limit": {"type": "integer", "minimum": 1, "maximum": 250}}),
    ),
    "mupot_operator_task_create": (
        "Create a scoped DME task assigned to this Hermes identity; this does not publish or mutate client systems.",
        _object_schema(
            {
                "title": {"type": "string", "maxLength": 240},
                "done_when": {"type": "string", "maxLength": 2000},
                "body": {"type": "string", "maxLength": 50000},
            },
            ["title", "done_when"],
        ),
    ),
    "mupot_operator_task_claim": (
        "Claim a permitted task for the configured Hermes identity and mark it in progress.",
        _object_schema({"task_id": {"type": "string"}}, ["task_id"]),
    ),
    "mupot_operator_record_finding": (
        "Record evidence or findings on a task. Only in_progress or blocked states are accepted.",
        _object_schema(
            {
                "task_id": {"type": "string"},
                "body": {"type": "string", "maxLength": 50000},
                "status": {"type": "string", "enum": ["in_progress", "blocked"]},
            },
            ["task_id", "body"],
        ),
    ),
    "mupot_operator_request_approval": (
        "Submit findings for the configured human approval owner. This tool cannot approve or reject them.",
        _object_schema(
            {
                "task_id": {"type": "string"},
                "body": {"type": "string", "maxLength": 50000},
            },
            ["task_id", "body"],
        ),
    ),
    "mupot_operator_complete_task": (
        "Complete an ungated internal task. Mupot rejects completion when an approval gate remains unresolved.",
        _object_schema(
            {
                "task_id": {"type": "string"},
                "body": {"type": "string", "maxLength": 50000},
            },
            ["task_id"],
        ),
    ),
    "mupot_agent_manager_list": (
        "List agents and non-secret credential metadata in the configured squad.",
        _object_schema({}),
    ),
    "mupot_agent_manager_create": (
        "Create an active member-role agent in the configured squad. Role and status cannot be chosen by the caller.",
        _object_schema(
            {
                "slug": {"type": "string", "maxLength": 48},
                "name": {"type": "string", "maxLength": 240},
                "model": {"type": "string", "maxLength": 240},
            },
            ["slug", "name"],
        ),
    ),
    "mupot_agent_manager_set_status": (
        "Pause or resume an agent in the configured squad.",
        _object_schema(
            {
                "agent_id": {"type": "string"},
                "status": {"type": "string", "enum": ["active", "paused"]},
            },
            ["agent_id", "status"],
        ),
    ),
    "mupot_agent_manager_mint_token": (
        "Mint a show-once, agent-bound member credential for an agent in the configured squad. Never print or copy the raw value into tasks or chat.",
        _object_schema(
            {
                "agent_id": {"type": "string"},
                "operation_id": {
                    "type": "string",
                    "minLength": 8,
                    "maxLength": 128,
                    "description": "Stable caller-generated ID; reuse it for retries of the same mint operation.",
                },
                "label": {"type": "string", "maxLength": 64},
            },
            ["agent_id", "operation_id"],
        ),
    ),
    "mupot_agent_manager_revoke_token": (
        "Revoke an agent-bound credential in the configured squad using its non-secret token ID.",
        _object_schema({"token_id": {"type": "string"}}, ["token_id"]),
    ),
}


def register_operator_tools(ctx: PluginContextLike, client: MupotOperatorClient) -> None:
    handlers = build_operator_handlers(client)
    names = OPERATOR_TOOL_NAMES
    if client.settings.agent_manager_enabled:
        names += MANAGER_LIFECYCLE_TOOL_NAMES
    if client.settings.agent_manager_credentials_enabled:
        names += MANAGER_CREDENTIAL_TOOL_NAMES
    for name in names:
        description, parameters = _TOOL_DEFINITIONS[name]
        ctx.register_tool(
            name=name,
            handler=lambda args, _handler=handlers[name], **_metadata: _handler(args),
            schema={"name": name, "description": description, "parameters": parameters},
            toolset=(
                "mupot-agent-manager" if name in MANAGER_TOOL_NAMES else "mupot-operator"
            ),
        )
