"""Contract tests for the restricted Mupot operator surface used by DME Hermes."""

from __future__ import annotations

from dataclasses import replace
import json
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
from typing import Any

from plugin.operator import (
    MANAGER_TOOL_NAMES,
    OPERATOR_TOOL_NAMES,
    MupotOperatorClient,
    OperatorSettings,
    build_operator_handlers,
    register_operator_tools,
)


class RecordingTransport:
    def __init__(
        self,
        *,
        capability: str = "member",
        bound_agent_id: str = "hermes-dme",
        surface_capabilities: tuple[str, ...] = (),
    ) -> None:
        self.calls: list[dict[str, Any]] = []
        self.capability = capability
        self.bound_agent_id = bound_agent_id
        self.surface_capabilities = surface_capabilities

    def __call__(
        self,
        url: str,
        headers: dict[str, str],
        payload: dict[str, Any],
        timeout: float,
    ) -> dict[str, Any]:
        self.calls.append(
            {"url": url, "headers": headers, "payload": payload, "timeout": timeout}
        )
        action = url.rsplit("/", 1)[-1]
        if action == "status":
            return {
                "ok": True,
                "tool": "status",
                "result": {
                    "tenant": "dme",
                    "role": "member",
                    "bound_agent_id": self.bound_agent_id,
                    "capabilities": [
                        {
                            "scope_type": "squad",
                            "scope_id": "squad-dme",
                            "capability": self.capability,
                        }
                    ],
                    "surface_capabilities": list(self.surface_capabilities),
                },
            }
        if action == "agent_manager_status":
            if "agents:manage" not in self.surface_capabilities:
                return {"ok": False, "tool": action, "error": "forbidden"}
            return {
                "ok": True,
                "tool": action,
                "result": {
                    "enabled": True,
                    "surface": "agents:manage",
                    "squad_id": "squad-dme",
                    "actor_member_id": "member-manager",
                    "bound_agent_id": self.bound_agent_id,
                },
            }
        return {"ok": True, "tool": action, "result": {"accepted": True, "args": payload}}


def decoded(handler: Any, args: dict[str, Any]) -> dict[str, Any]:
    value = handler(args)
    if not isinstance(value, str):
        raise AssertionError("Hermes handlers must return strings")
    return json.loads(value)


class OperatorTests(unittest.TestCase):
    def setUp(self) -> None:
        secret_dir = tempfile.TemporaryDirectory()
        self.addCleanup(secret_dir.cleanup)
        self.settings = OperatorSettings(
            base_url="https://agents.digid.ca",
            expected_tenant="dme",
            squad_id="squad-dme",
            agent_id="hermes-dme",
            approval_owner="Maryam Golabgir",
            pubsub_peer_agent_ids=("peer-agent",),
            timeout=12.0,
            agent_manager_secret_dir=secret_dir.name,
        )

    def client(self, transport: RecordingTransport) -> MupotOperatorClient:
        return MupotOperatorClient(
            self.settings,
            token="mupot_test_agent_token",
            transport=transport,
        )

    def test_settings_require_https_except_loopback(self) -> None:
        self.settings.validate()
        replace(self.settings, base_url="http://127.0.0.1:8787").validate()
        replace(self.settings, base_url="http://localhost:8787").validate()
        with self.assertRaisesRegex(ValueError, "HTTPS"):
            replace(self.settings, base_url="http://agents.digid.ca").validate()

    def test_settings_accept_single_pubsub_peer_scalar(self) -> None:
        settings = OperatorSettings.from_mapping(
            {
                "base_url": "https://agents.digid.ca",
                "expected_tenant": "dme",
                "squad_id": "squad-dme",
                "agent_id": "hermes-dme",
                "approval_owner": "Maryam Golabgir",
                "pubsub_peer_agent_ids": "peer-agent",
            }
        )
        self.assertEqual(settings.pubsub_peer_agent_ids, ("peer-agent",))

    def test_client_refuses_actions_outside_fixed_allowlist(self) -> None:
        transport = RecordingTransport()
        result = self.client(transport).call("mint_agent_token", {})
        self.assertEqual(
            result,
            {"ok": False, "error": "action_not_allowed", "action": "mint_agent_token"},
        )
        self.assertEqual(transport.calls, [])

    def test_client_never_returns_or_places_token_in_request_body(self) -> None:
        transport = RecordingTransport()
        token = "mupot_secret_agent_token"
        client = MupotOperatorClient(self.settings, token=token, transport=transport)
        result = client.call("task_board", {"limit": 20})
        self.assertTrue(result["ok"])
        self.assertNotIn(token, json.dumps(result))
        self.assertTrue(
            all(token not in json.dumps(call["payload"]) for call in transport.calls)
        )
        self.assertTrue(
            all(call["headers"]["Authorization"] == f"Bearer {token}" for call in transport.calls)
        )

    def test_client_fails_closed_when_token_is_not_welded(self) -> None:
        transport = RecordingTransport(bound_agent_id="another-agent")
        result = self.client(transport).call("task_board", {})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "identity_mismatch")
        self.assertEqual(len(transport.calls), 1)

    def test_client_fails_closed_for_owner_or_admin_capability(self) -> None:
        for capability in ("admin", "owner"):
            with self.subTest(capability=capability):
                transport = RecordingTransport(capability=capability)
                result = self.client(transport).call("task_create", {"title": "x"})
                self.assertFalse(result["ok"])
                self.assertEqual(result["error"], "overprivileged_identity")
                self.assertEqual(len(transport.calls), 1)

    def test_task_create_injects_fixed_scope_and_self_assignment(self) -> None:
        transport = RecordingTransport()
        handlers = build_operator_handlers(self.client(transport))
        result = decoded(
            handlers["mupot_operator_task_create"],
            {
                "title": "Inspect technical visibility",
                "done_when": "Evidence record includes source and collection time",
                "body": "Read-only scan",
            },
        )
        self.assertTrue(result["ok"])
        action_call = transport.calls[-1]
        self.assertTrue(action_call["url"].endswith("/actions/task_create"))
        self.assertEqual(
            action_call["payload"],
            {
                "squad_id": "squad-dme",
                "assignee_agent_id": "hermes-dme",
                "title": "Inspect technical visibility",
                "done_when": "Evidence record includes source and collection time",
                "body": "Read-only scan",
            },
        )

    def test_task_claim_can_only_assign_configured_hermes_agent(self) -> None:
        transport = RecordingTransport()
        handlers = build_operator_handlers(self.client(transport))
        result = decoded(handlers["mupot_operator_task_claim"], {"task_id": "task-1"})
        self.assertTrue(result["ok"])
        self.assertEqual(
            transport.calls[-1]["payload"],
            {
                "squad_id": "squad-dme",
                "task_id": "task-1",
                "assignee_agent_id": "hermes-dme",
                "status": "in_progress",
            },
        )

    def test_publish_uses_welded_sender_and_requires_idempotency_key(self) -> None:
        transport = RecordingTransport()
        handlers = build_operator_handlers(self.client(transport))

        result = decoded(
            handlers["mupot_operator_send"],
            {
                "to": "peer-agent",
                "body": "Please process task task-1",
                "kind": "request",
                "request_id": "task-1-dispatch-v1",
            },
        )

        self.assertTrue(result["ok"])
        self.assertTrue(transport.calls[-1]["url"].endswith("/actions/send"))
        self.assertEqual(
            transport.calls[-1]["payload"],
            {
                "to": "peer-agent",
                "body": "Please process task task-1",
                "kind": "request",
                "request_id": "task-1-dispatch-v1",
            },
        )
        self.assertNotIn("from", transport.calls[-1]["payload"])
        self.assertNotIn("tenant", transport.calls[-1]["payload"])

        missing = decoded(
            handlers["mupot_operator_send"],
            {"to": "peer-agent", "body": "unsafe retry"},
        )
        self.assertEqual(missing, {"ok": False, "error": "to_body_and_request_id_required"})

        calls_before_denial = len(transport.calls)
        denied = decoded(
            handlers["mupot_operator_send"],
            {
                "to": "not-an-allowlisted-peer",
                "body": "cross-scope attempt",
                "request_id": "deny-test-1",
            },
        )
        self.assertEqual(denied, {"ok": False, "error": "pubsub_peer_not_allowed"})
        self.assertEqual(len(transport.calls), calls_before_denial)

    def test_inbox_peeks_by_default_and_consumes_only_explicitly(self) -> None:
        transport = RecordingTransport()
        handlers = build_operator_handlers(self.client(transport))

        peeked = decoded(handlers["mupot_operator_inbox"], {"limit": 7})
        self.assertTrue(peeked["ok"])
        self.assertTrue(transport.calls[-1]["url"].endswith("/actions/inbox"))
        self.assertEqual(transport.calls[-1]["payload"], {"limit": 7, "peek": True})

        consumed = decoded(
            handlers["mupot_operator_inbox"],
            {"limit": 2, "consume": True},
        )
        self.assertTrue(consumed["ok"])
        self.assertEqual(transport.calls[-1]["payload"], {"limit": 2, "peek": False})

    def test_request_approval_routes_to_configured_human_without_verdict_power(self) -> None:
        transport = RecordingTransport()
        handlers = build_operator_handlers(self.client(transport))
        result = decoded(
            handlers["mupot_operator_request_approval"],
            {"task_id": "task-2", "body": "Recommendation with evidence references"},
        )
        self.assertTrue(result["ok"])
        self.assertTrue(transport.calls[-1]["url"].endswith("/actions/task_update"))
        self.assertEqual(
            transport.calls[-1]["payload"],
            {
                "squad_id": "squad-dme",
                "task_id": "task-2",
                "body": "Recommendation with evidence references",
                "gate_owner": "Maryam Golabgir",
                "status": "review",
            },
        )
        self.assertTrue(all("verdict" not in call["url"] for call in transport.calls))

    def test_record_finding_updates_body_without_replaying_in_progress_transition(self) -> None:
        transport = RecordingTransport()
        handlers = build_operator_handlers(self.client(transport))

        result = decoded(
            handlers["mupot_operator_record_finding"],
            {"task_id": "task-3", "body": "Evidence"},
        )

        self.assertTrue(result["ok"])
        self.assertEqual(
            transport.calls[-1]["payload"],
            {
                "squad_id": "squad-dme",
                "task_id": "task-3",
                "body": "Evidence",
            },
        )

        blocked = decoded(
            handlers["mupot_operator_record_finding"],
            {"task_id": "task-3", "body": "Waiting for input", "status": "blocked"},
        )
        self.assertTrue(blocked["ok"])
        self.assertEqual(transport.calls[-1]["payload"]["status"], "blocked")

    def test_record_finding_rejects_completion_and_approval_statuses(self) -> None:
        transport = RecordingTransport()
        handlers = build_operator_handlers(self.client(transport))
        for status in ("done", "review", "approved", "rejected"):
            with self.subTest(status=status):
                result = decoded(
                    handlers["mupot_operator_record_finding"],
                    {"task_id": "task-3", "body": "Evidence", "status": status},
                )
                self.assertEqual(
                    result,
                    {"ok": False, "error": "status_not_allowed", "status": status},
                )
        self.assertEqual(transport.calls, [])

    def test_registered_surface_contains_no_admin_or_external_action_tools(self) -> None:
        transport = RecordingTransport()

        class Context:
            def __init__(self) -> None:
                self.tools: list[dict[str, Any]] = []

            def register_tool(self, **kwargs: Any) -> None:
                self.tools.append(kwargs)

        ctx = Context()
        register_operator_tools(ctx, self.client(transport))
        names = {tool["name"] for tool in ctx.tools}
        self.assertEqual(names, set(OPERATOR_TOOL_NAMES))
        self.assertTrue(all(tool["toolset"] == "mupot-operator" for tool in ctx.tools))
        self.assertTrue(all("handler" in tool and "schema" in tool for tool in ctx.tools))
        forbidden = {
            "grant",
            "mint",
            "permission",
            "publish",
            "spend",
            "delete",
            "email",
            "social",
            "verdict",
            "execute",
        }
        self.assertFalse(any(fragment in name for name in names for fragment in forbidden))

    def test_registered_handlers_accept_hermes_task_metadata(self) -> None:
        transport = RecordingTransport()

        class Context:
            def __init__(self) -> None:
                self.tools: list[dict[str, Any]] = []

            def register_tool(self, **kwargs: Any) -> None:
                self.tools.append(kwargs)

        ctx = Context()
        register_operator_tools(ctx, self.client(transport))
        status_tool = next(
            tool for tool in ctx.tools if tool["name"] == "mupot_operator_status"
        )

        result = json.loads(status_tool["handler"]({}, task_id="hermes-tool-call-1"))

        self.assertTrue(result["ok"])
        self.assertEqual(result["result"]["tenant"], "dme")

    def test_manager_tools_are_absent_unless_explicitly_enabled(self) -> None:
        transport = RecordingTransport(surface_capabilities=("agents:manage",))

        class Context:
            def __init__(self) -> None:
                self.tools: list[dict[str, Any]] = []

            def register_tool(self, **kwargs: Any) -> None:
                self.tools.append(kwargs)

        ctx = Context()
        register_operator_tools(ctx, self.client(transport))
        names = {tool["name"] for tool in ctx.tools}
        self.assertTrue(set(MANAGER_TOOL_NAMES).isdisjoint(names))

    def test_manager_tools_register_with_explicit_setting_and_fixed_squad(self) -> None:
        settings = replace(self.settings, agent_manager_enabled=True)
        transport = RecordingTransport(surface_capabilities=("agents:manage",))
        client = MupotOperatorClient(settings, token="mupot_test_agent_token", transport=transport)

        class Context:
            def __init__(self) -> None:
                self.tools: list[dict[str, Any]] = []

            def register_tool(self, **kwargs: Any) -> None:
                self.tools.append(kwargs)

        ctx = Context()
        register_operator_tools(ctx, client)
        names = {tool["name"] for tool in ctx.tools}
        self.assertEqual(set(MANAGER_TOOL_NAMES), names - set(OPERATOR_TOOL_NAMES))

        handlers = build_operator_handlers(client)
        result = decoded(
            handlers["mupot_agent_manager_create"],
            {"slug": "worker-2", "name": "Worker Two", "model": "gpt-5.6-sol"},
        )
        self.assertTrue(result["ok"])
        self.assertEqual(
            transport.calls[-1]["payload"],
            {
                "squad_id": "squad-dme",
                "slug": "worker-2",
                "name": "Worker Two",
                "model": "gpt-5.6-sol",
            },
        )

    def test_manager_action_fails_closed_without_surface_capability(self) -> None:
        settings = replace(self.settings, agent_manager_enabled=True)
        transport = RecordingTransport(surface_capabilities=())
        client = MupotOperatorClient(settings, token="mupot_test_agent_token", transport=transport)

        result = client.call("agent_manager_list", {"squad_id": "squad-dme"})

        self.assertEqual(result, {"ok": False, "error": "manager_capability_missing"})
        self.assertEqual(len(transport.calls), 2)
        self.assertTrue(transport.calls[0]["url"].endswith("/actions/status"))
        self.assertTrue(
            transport.calls[1]["url"].endswith("/actions/agent_manager_status")
        )

    def test_manager_mint_persists_plaintext_only_in_private_secret_file(self) -> None:
        raw = "mupot_show_once_worker_secret"
        token_id = "token-safe-123"

        class MintTransport(RecordingTransport):
            def __call__(self, url: str, headers: dict[str, str], payload: dict[str, Any], timeout: float) -> dict[str, Any]:
                response = super().__call__(url, headers, payload, timeout)
                if url.endswith("/agent_manager_mint_token"):
                    return {
                        "ok": True,
                        "tool": "agent_manager_mint_token",
                        "result": {
                            "token": {
                                "id": token_id,
                                "agent_id": "worker-2",
                                "label": "worker-2",
                                "raw": raw,
                            }
                        },
                    }
                return response

        settings = replace(self.settings, agent_manager_enabled=True)
        transport = MintTransport(surface_capabilities=("agents:manage",))
        client = MupotOperatorClient(settings, token="mupot_test_agent_token", transport=transport)
        result = decoded(
            build_operator_handlers(client)["mupot_agent_manager_mint_token"],
            {"agent_id": "worker-2"},
        )

        serialized = json.dumps(result)
        self.assertNotIn(raw, serialized)
        secret_ref = Path(result["result"]["token"]["secret_ref"])
        self.assertEqual(secret_ref.read_text(encoding="utf-8"), raw)
        self.assertEqual(stat.S_IMODE(secret_ref.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(secret_ref.parent.stat().st_mode), 0o700)

    def test_manager_mint_revokes_when_secret_file_cannot_be_created(self) -> None:
        raw = "mupot_show_once_worker_secret"
        token_id = "token-collision-123"

        class MintTransport(RecordingTransport):
            def __call__(self, url: str, headers: dict[str, str], payload: dict[str, Any], timeout: float) -> dict[str, Any]:
                response = super().__call__(url, headers, payload, timeout)
                if url.endswith("/agent_manager_mint_token"):
                    return {
                        "ok": True,
                        "tool": "agent_manager_mint_token",
                        "result": {"token": {"id": token_id, "agent_id": "worker-2", "raw": raw}},
                    }
                return response

        secret_path = Path(self.settings.agent_manager_secret_dir) / f"{token_id}.token"
        secret_path.parent.mkdir(mode=0o700, exist_ok=True)
        secret_path.write_text("do-not-overwrite", encoding="utf-8")
        settings = replace(self.settings, agent_manager_enabled=True)
        transport = MintTransport(surface_capabilities=("agents:manage",))
        client = MupotOperatorClient(settings, token="mupot_test_agent_token", transport=transport)

        result = decoded(
            build_operator_handlers(client)["mupot_agent_manager_mint_token"],
            {"agent_id": "worker-2"},
        )

        serialized = json.dumps(result)
        self.assertNotIn(raw, serialized)
        self.assertEqual(result["error"], "secret_persistence_failed")
        self.assertEqual(secret_path.read_text(encoding="utf-8"), "do-not-overwrite")
        revoke_calls = [call for call in transport.calls if call["url"].endswith("/agent_manager_revoke_token")]
        self.assertEqual(len(revoke_calls), 1)
        self.assertEqual(
            revoke_calls[0]["payload"],
            {"squad_id": "squad-dme", "token_id": token_id},
        )

    def test_plugin_settings_failure_registers_no_fallback_surface(self) -> None:
        from plugin import register

        class Context:
            def __init__(self) -> None:
                self.tools: list[dict[str, Any]] = []

            def register_tool(self, **kwargs: Any) -> None:
                self.tools.append(kwargs)

        for loaded in ({}, RuntimeError("simulated config failure")):
            with self.subTest(loaded=type(loaded).__name__):
                ctx = Context()
                patcher = (
                    patch("plugin._load_plugin_settings", side_effect=loaded)
                    if isinstance(loaded, BaseException)
                    else patch("plugin._load_plugin_settings", return_value=loaded)
                )
                with patcher, patch.dict("os.environ", {}, clear=True):
                    with self.assertRaises((RuntimeError, ValueError)):
                        register(ctx)
                self.assertEqual(ctx.tools, [])

    def test_plugin_operator_mode_registers_only_the_restricted_surface(self) -> None:
        from plugin import register

        class Context:
            def __init__(self) -> None:
                self.tools: list[dict[str, Any]] = []
                self.platforms: list[dict[str, Any]] = []

            def register_tool(self, **kwargs: Any) -> None:
                self.tools.append(kwargs)

            def register_platform(self, **kwargs: Any) -> None:
                self.platforms.append(kwargs)

        config = {
            "mode": "operator",
            "operator": {
                "base_url": "https://agents.digid.ca",
                "expected_tenant": "dme",
                "squad_id": "squad-dme",
                "agent_id": "hermes-dme",
                "approval_owner": "Maryam Golabgir",
            },
        }
        ctx = Context()
        with patch("plugin._load_plugin_settings", return_value=config), patch.dict(
            "os.environ", {"MUPOT_AGENT_TOKEN": "mupot_test_agent_token"}, clear=False
        ):
            register(ctx)

        self.assertEqual({tool["name"] for tool in ctx.tools}, set(OPERATOR_TOOL_NAMES))
        self.assertTrue(all(tool["toolset"] == "mupot-operator" for tool in ctx.tools))
        self.assertEqual(ctx.platforms, [])


if __name__ == "__main__":
    unittest.main()
