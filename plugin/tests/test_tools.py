"""
Unit tests for the mupot Hermes plugin tools.
No network calls, no real Cloudflare account required.
All CF client calls are mocked via the injectable DryRunClient or explicit test doubles.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

# Adjust sys.path so tests run from the plugin dir or the repo root
import sys
import os

# Allow: pytest tests/ from /home/mumega/mupot/plugin/
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from plugin.schemas import (
    MUPOT_BRAIN_ENABLE_SCHEMA,
    MUPOT_PROVISION_SCHEMA,
    MUPOT_STATUS_SCHEMA,
)
from plugin.tools import (
    DryRunClient,
    _validate_slug,
    mupot_brain_enable,
    mupot_provision,
    mupot_status,
)


# ── helpers ──────────────────────────────────────────────────────────────────


def _validate_jsonschema(instance: dict[str, Any], schema: dict[str, Any]) -> None:
    """
    Minimal JSON Schema validator for required + type checks.
    Avoids pulling in jsonschema as a test dependency.
    """
    required = schema.get("required", [])
    for key in required:
        assert key in instance, f"Required field '{key}' missing from {instance!r}"

    props = schema.get("properties", {})
    for key, val in instance.items():
        if key in props:
            prop_schema = props[key]
            expected_type = prop_schema.get("type")
            if expected_type == "string":
                assert isinstance(val, str), f"'{key}' must be str, got {type(val)}"
            elif expected_type == "boolean":
                assert isinstance(val, bool), f"'{key}' must be bool, got {type(val)}"


# ── Schema validation tests ──────────────────────────────────────────────────


class TestSchemaValidation:
    def test_provision_schema_has_required_fields(self) -> None:
        required = MUPOT_PROVISION_SCHEMA["required"]
        assert "slug" in required
        assert "brand" in required
        assert "cf_account_id" in required
        assert "cf_api_token" in required

    def test_provision_schema_confirm_defaults_false(self) -> None:
        assert MUPOT_PROVISION_SCHEMA["properties"]["confirm"]["default"] is False

    def test_provision_schema_dry_run_defaults_true(self) -> None:
        assert MUPOT_PROVISION_SCHEMA["properties"]["dry_run"]["default"] is True

    def test_provision_schema_slug_pattern(self) -> None:
        pattern = MUPOT_PROVISION_SCHEMA["properties"]["slug"]["pattern"]
        slug_re = re.compile(pattern)
        assert slug_re.match("acme")
        assert slug_re.match("my-company")
        assert slug_re.match("a1")
        assert not slug_re.match("ACME")  # no uppercase
        assert not slug_re.match("-acme")  # leading hyphen
        assert not slug_re.match("acme-")  # trailing hyphen
        assert not slug_re.match("a")  # too short (only 1 char, pattern needs 2+)

    def test_status_schema_has_url_required(self) -> None:
        assert "url" in MUPOT_STATUS_SCHEMA["required"]
        assert MUPOT_STATUS_SCHEMA["properties"]["url"]["format"] == "uri"

    def test_brain_enable_schema_has_slug_required(self) -> None:
        assert "slug" in MUPOT_BRAIN_ENABLE_SCHEMA["required"]

    def test_brain_enable_schema_optional_fields_have_defaults(self) -> None:
        props = MUPOT_BRAIN_ENABLE_SCHEMA["properties"]
        assert props["hermes_home"]["default"] == "~/.hermes"
        assert props["openrouter_api_key_env"]["default"] == "OPENROUTER_API_KEY"

    def test_provision_schema_no_additional_properties(self) -> None:
        assert MUPOT_PROVISION_SCHEMA.get("additionalProperties") is False

    def test_status_schema_no_additional_properties(self) -> None:
        assert MUPOT_STATUS_SCHEMA.get("additionalProperties") is False

    def test_brain_enable_schema_no_additional_properties(self) -> None:
        assert MUPOT_BRAIN_ENABLE_SCHEMA.get("additionalProperties") is False


# ── Slug validation ───────────────────────────────────────────────────────────


class TestSlugValidation:
    def test_valid_slugs(self) -> None:
        for slug in ["acme", "my-company", "a1", "x9", "foo-bar-baz"]:
            _validate_slug(slug)  # must not raise

    def test_invalid_slug_uppercase(self) -> None:
        with pytest.raises(ValueError, match="Invalid slug"):
            _validate_slug("ACME")

    def test_invalid_slug_leading_hyphen(self) -> None:
        with pytest.raises(ValueError, match="Invalid slug"):
            _validate_slug("-acme")

    def test_invalid_slug_trailing_hyphen(self) -> None:
        with pytest.raises(ValueError, match="Invalid slug"):
            _validate_slug("acme-")

    def test_invalid_slug_single_char(self) -> None:
        # Pattern requires at least 2 chars ([a-z0-9] + {0,28} + [a-z0-9])
        # But single char matches first char class only — test the boundary
        with pytest.raises(ValueError, match="Invalid slug"):
            _validate_slug("a")

    def test_invalid_slug_spaces(self) -> None:
        with pytest.raises(ValueError, match="Invalid slug"):
            _validate_slug("my company")

    def test_invalid_slug_special_chars(self) -> None:
        with pytest.raises(ValueError, match="Invalid slug"):
            _validate_slug("my_company")


# ── mupot_provision: dry-run mode ────────────────────────────────────────────


class TestMupotProvisionDryRun:
    def test_dry_run_returns_plan_not_applied(self) -> None:
        result = mupot_provision(
            slug="acme",
            brand="Acme Corp",
            cf_account_id="a" * 32,
            cf_api_token="tok_" + "x" * 40,
        )
        assert result["dry_run"] is True
        assert result["applied"] is False
        assert result["toml_path"] is None

    def test_dry_run_plan_contains_create_actions(self) -> None:
        result = mupot_provision(
            slug="acme",
            brand="Acme Corp",
            cf_account_id="a" * 32,
            cf_api_token="tok_" + "x" * 40,
        )
        plan_str = "\n".join(result["plan"])
        assert "CREATE" in plan_str or "SKIP" in plan_str

    def test_dry_run_emits_migration_warning_in_next_steps(self) -> None:
        result = mupot_provision(
            slug="acme",
            brand="Acme Corp",
            cf_account_id="a" * 32,
            cf_api_token="tok_" + "x" * 40,
        )
        next_steps_str = "\n".join(result["next_steps"])
        # Must tell the user to dry-run migrations (Risk 2)
        assert "--dry-run" in next_steps_str or "dry-run" in next_steps_str.lower()

    def test_dry_run_next_steps_is_honest_plan_only(self) -> None:
        """v0.1 default output must emit manual wrangler commands and must NOT claim
        confirm applies (Codex re-gate P0 — v0.1 has no SDK)."""
        result = mupot_provision(
            slug="acme",
            brand="Acme Corp",
            cf_account_id="a" * 32,
            cf_api_token="tok_" + "x" * 40,
        )
        next_steps_str = "\n".join(result["next_steps"])
        assert "wrangler d1 create" in next_steps_str
        assert "PLAN-ONLY" in next_steps_str
        assert "confirm=True, dry_run=False to apply" not in next_steps_str
        assert "After apply" not in next_steps_str

    def test_dry_run_uses_dry_run_client(self) -> None:
        # DryRunClient records calls but never hits CF
        dry = DryRunClient()
        mupot_provision(
            slug="acme",
            brand="Acme Corp",
            cf_account_id="a" * 32,
            cf_api_token="tok_" + "x" * 40,
            cf_client=dry,
        )
        # Must have called list methods (idempotent guard)
        methods = [c["method"] for c in dry.calls]
        assert "list_d1_databases" in methods
        assert "list_kv_namespaces" in methods

    def test_dry_run_workers_slot_warning_present(self) -> None:
        result = mupot_provision(
            slug="acme",
            brand="Acme Corp",
            cf_account_id="a" * 32,
            cf_api_token="tok_" + "x" * 40,
        )
        warnings_str = "\n".join(result["warnings"])
        assert "slot" in warnings_str.lower() or "Workers" in warnings_str

    def test_dry_run_slug_in_result(self) -> None:
        result = mupot_provision(
            slug="myorg",
            brand="MyOrg",
            cf_account_id="b" * 32,
            cf_api_token="tok_" + "y" * 40,
        )
        assert result["slug"] == "myorg"
        assert "mupot-myorg" in result["worker_name"]

    def test_explicit_dry_run_true_overrides_confirm_true(self) -> None:
        """dry_run=True must take precedence over confirm=True (safety guard)."""
        result = mupot_provision(
            slug="acme",
            brand="Acme Corp",
            cf_account_id="a" * 32,
            cf_api_token="tok_" + "x" * 40,
            confirm=True,
            dry_run=True,  # explicit dry_run wins
        )
        assert result["dry_run"] is True
        assert result["applied"] is False


# ── mupot_provision: idempotent list-guard ───────────────────────────────────


class TestMupotProvisionIdempotentGuard:
    def _make_client_with_existing(
        self, slug: str
    ) -> "PreseedClient":
        """Client that pretends D1 + both KV namespaces already exist."""

        @dataclass
        class PreseedClient:
            calls: list[dict[str, Any]] = field(default_factory=list)

            def list_d1_databases(self, account_id: str) -> list[dict[str, Any]]:
                self.calls.append({"method": "list_d1_databases"})
                return [{"name": f"mupot-{slug}", "id": "existing-d1-id"}]

            def list_kv_namespaces(self, account_id: str) -> list[dict[str, Any]]:
                self.calls.append({"method": "list_kv_namespaces"})
                return [
                    {"title": f"mupot-{slug}-sessions", "id": "existing-sess-id"},
                    {"title": f"mupot-{slug}-oauth", "id": "existing-oauth-id"},
                ]

            def create_d1_database(
                self, account_id: str, name: str
            ) -> dict[str, Any]:
                self.calls.append({"method": "create_d1_database"})
                return {"id": "should-not-be-called", "name": name}

            def create_kv_namespace(
                self, account_id: str, title: str
            ) -> dict[str, Any]:
                self.calls.append({"method": "create_kv_namespace"})
                return {"id": "should-not-be-called", "title": title}

        return PreseedClient()

    def test_idempotent_skips_existing_d1(self) -> None:
        client = self._make_client_with_existing("acme")
        result = mupot_provision(
            slug="acme",
            brand="Acme Corp",
            cf_account_id="a" * 32,
            cf_api_token="tok",
            cf_client=client,
        )
        plan_str = "\n".join(result["plan"])
        # All three should be SKIP
        assert plan_str.count("[SKIP]") == 3
        # No CREATE calls should have been recorded
        create_calls = [
            c for c in client.calls if c["method"].startswith("create_")
        ]
        assert len(create_calls) == 0

    def test_idempotent_creates_only_missing_resources(self) -> None:
        """Partial state: D1 exists, KV namespaces do not."""

        @dataclass
        class PartialClient:
            calls: list[dict[str, Any]] = field(default_factory=list)

            def list_d1_databases(self, account_id: str) -> list[dict[str, Any]]:
                self.calls.append({"method": "list_d1_databases"})
                return [{"name": "mupot-acme", "id": "existing-d1"}]

            def list_kv_namespaces(self, account_id: str) -> list[dict[str, Any]]:
                self.calls.append({"method": "list_kv_namespaces"})
                return []  # neither KV exists

            def create_d1_database(
                self, account_id: str, name: str
            ) -> dict[str, Any]:
                self.calls.append({"method": "create_d1_database", "name": name})
                return {"id": "new-d1", "name": name}

            def create_kv_namespace(
                self, account_id: str, title: str
            ) -> dict[str, Any]:
                self.calls.append({"method": "create_kv_namespace", "title": title})
                return {"id": "new-kv", "title": title}

        client = PartialClient()
        result = mupot_provision(
            slug="acme",
            brand="Acme Corp",
            cf_account_id="a" * 32,
            cf_api_token="tok",
            cf_client=client,
        )
        plan_str = "\n".join(result["plan"])
        # D1 should be SKIP, KV should be CREATE
        assert "[SKIP] D1" in plan_str
        assert "[CREATE] KV" in plan_str


# ── mupot_provision: apply gate ──────────────────────────────────────────────


class TestMupotProvisionApplyGate:
    def test_apply_without_client_returns_plan_only(self) -> None:
        """
        confirm=True + dry_run=False without an injected client must return an honest
        plan-only response (v0.1 does not bundle the CF SDK — no live calls are made).
        It must NOT raise — a bare RuntimeError is an unhelpful error surface.
        """
        result = mupot_provision(
            slug="acme",
            brand="Acme Corp",
            cf_account_id="a" * 32,
            cf_api_token="tok_" + "x" * 40,
            confirm=True,
            dry_run=False,
        )
        # Must be plan-only, not applied
        assert result["dry_run"] is True
        assert result["applied"] is False
        assert result["toml_path"] is None
        # Must clearly communicate it's plan-only
        plan_str = "\n".join(result["plan"])
        assert "v0.1" in plan_str or "PLAN-ONLY" in plan_str
        # Must include the wrangler CLI commands in next_steps
        next_str = "\n".join(result["next_steps"])
        assert "wrangler" in next_str

    def test_apply_with_client_creates_toml(self, tmp_path: Path) -> None:
        """With an injected client, apply mode writes the wrangler toml."""
        dry = DryRunClient()
        result = mupot_provision(
            slug="acme",
            brand="Acme Corp",
            cf_account_id="a" * 32,
            cf_api_token="tok",
            confirm=True,
            dry_run=False,
            cf_client=dry,
            toml_output_dir=tmp_path,
        )
        assert result["applied"] is True
        assert result["toml_path"] is not None
        toml_path = Path(result["toml_path"])
        assert toml_path.exists()
        content = toml_path.read_text()
        assert 'name = "mupot-acme"' in content
        assert 'TENANT_SLUG = "acme"' in content
        assert 'BRAND = "Acme Corp"' in content

    def test_apply_toml_contains_d1_and_kv_ids(self, tmp_path: Path) -> None:
        dry = DryRunClient()
        result = mupot_provision(
            slug="myorg",
            brand="My Org",
            cf_account_id="b" * 32,
            cf_api_token="tok",
            confirm=True,
            dry_run=False,
            cf_client=dry,
            toml_output_dir=tmp_path,
        )
        toml_content = Path(result["toml_path"]).read_text()
        assert result["d1_id"] in toml_content
        assert result["sessions_kv_id"] in toml_content
        assert result["oauth_kv_id"] in toml_content

    def test_apply_migration_step_in_next_steps_requires_dry_run_first(
        self, tmp_path: Path
    ) -> None:
        """After apply, next_steps must include migration DRY-RUN step (Risk 2)."""
        dry = DryRunClient()
        result = mupot_provision(
            slug="acme",
            brand="Acme Corp",
            cf_account_id="a" * 32,
            cf_api_token="tok",
            confirm=True,
            dry_run=False,
            cf_client=dry,
            toml_output_dir=tmp_path,
        )
        next_steps_str = "\n".join(result["next_steps"])
        # Must mention --dry-run BEFORE mentioning the apply step
        dry_run_pos = next_steps_str.find("--dry-run")
        assert dry_run_pos != -1, "next_steps must include --dry-run migration gate"
        # The word "apply" (without --dry-run) must come AFTER the dry-run mention
        # so operators see dry-run first in the flow
        apply_pos = next_steps_str.find("migrations apply", dry_run_pos)
        # If there's an apply step at all, there must be a dry-run step before it
        assert dry_run_pos < apply_pos or apply_pos == -1

    def test_apply_calls_create_on_client(self, tmp_path: Path) -> None:
        dry = DryRunClient()
        mupot_provision(
            slug="acme",
            brand="Acme Corp",
            cf_account_id="a" * 32,
            cf_api_token="tok",
            confirm=True,
            dry_run=False,
            cf_client=dry,
            toml_output_dir=tmp_path,
        )
        methods = [c["method"] for c in dry.calls]
        assert "create_d1_database" in methods
        assert "create_kv_namespace" in methods


# ── mupot_status ──────────────────────────────────────────────────────────────


class TestMupotStatus:
    def test_no_http_fetch_returns_dry_run(self) -> None:
        result = mupot_status("https://mupot-acme.workers.dev")
        assert result["dry_run"] is True
        assert result["ok"] is None
        assert "No http_fetch injected" in result["message"]

    def test_url_normalised(self) -> None:
        result = mupot_status("https://mupot-acme.workers.dev/")
        assert result["url"] == "https://mupot-acme.workers.dev"
        assert result["health_url"] == "https://mupot-acme.workers.dev/health"

    def test_injected_200_returns_ok_true(self) -> None:
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"tenant": "acme", "status": "ok"}
        result = mupot_status(
            "https://mupot-acme.workers.dev",
            http_fetch=lambda url: mock_resp,
        )
        assert result["ok"] is True
        assert result["tenant"] == "acme"
        assert result["dry_run"] is False

    def test_injected_500_returns_ok_false(self) -> None:
        mock_resp = MagicMock()
        mock_resp.status_code = 500
        result = mupot_status(
            "https://mupot-acme.workers.dev",
            http_fetch=lambda url: mock_resp,
        )
        assert result["ok"] is False
        assert result["status_code"] == 500

    def test_injected_exception_returns_error(self) -> None:
        def failing_fetch(url: str) -> None:
            raise ConnectionError("connection refused")

        result = mupot_status(
            "https://mupot-acme.workers.dev",
            http_fetch=failing_fetch,
        )
        assert result["ok"] is False
        assert "connection refused" in result["error"]


# ── mupot_brain_enable ────────────────────────────────────────────────────────


class TestMupotBrainEnable:
    def test_returns_plan_not_executed(self) -> None:
        result = mupot_brain_enable(slug="acme")
        # v0.1 is always dry_run (emits plan only)
        assert result["dry_run"] is True

    def test_emits_config_yaml(self) -> None:
        result = mupot_brain_enable(slug="acme")
        assert "config_yaml" in result
        assert "qwen/qwen3.7-plus" in result["config_yaml"]

    def test_emits_cron_script(self) -> None:
        result = mupot_brain_enable(slug="acme")
        assert "cron_script" in result
        assert "acme" in result["cron_script"]

    def test_cron_script_is_real_file_not_symlink(self) -> None:
        """
        Cron script path must be a real file path. The content must not use symlinks.
        Check that the script content doesn't ln -s and that the path comment says REAL FILE.
        """
        result = mupot_brain_enable(slug="acme")
        cron_script = result["cron_script"]
        # Script should explicitly say REAL FILE (our guard against the symlink gotcha)
        assert "REAL FILE" in cron_script
        # Script must not contain symlink creation
        assert "ln -s" not in cron_script
        assert "os.symlink" not in cron_script

    def test_cron_script_path_is_under_hermes_scripts(self) -> None:
        result = mupot_brain_enable(slug="acme", hermes_home="~/.hermes")
        assert "~/.hermes/scripts" in result["cron_script_path"]

    def test_cron_entry_schedule_is_15_minutes(self) -> None:
        result = mupot_brain_enable(slug="acme")
        assert result["cron_entry"]["schedule"] == "*/15 * * * *"

    def test_scoped_token_var_in_result(self) -> None:
        """Brain token must be scoped — NOT mcp:* (Risk 3)."""
        result = mupot_brain_enable(slug="acme")
        token_var = result["token_env_var"]
        # Must be a per-slug scoped token env var, not a wildcard
        assert "ACME" in token_var
        assert "mcp" not in token_var.lower()

    def test_scoped_token_warning_mentions_not_mcp_star(self) -> None:
        """Warnings must say NOT mcp:* AND that scope enforcement is operator's responsibility."""
        result = mupot_brain_enable(slug="acme")
        warnings_str = "\n".join(result["warnings"])
        assert "mcp:*" in warnings_str
        assert "NOT" in warnings_str or "not" in warnings_str
        # v0.1 documents but cannot enforce scope — must say so
        assert "cannot enforce" in warnings_str or "operator" in warnings_str.lower()

    def test_token_var_next_steps_mention_task_read_priority_write(self) -> None:
        """next_steps must mention the specific scopes required."""
        result = mupot_brain_enable(slug="acme")
        next_steps_str = "\n".join(result["next_steps"])
        assert "task:read" in next_steps_str
        assert "priority:write" in next_steps_str

    def test_cron_script_checks_token_before_running(self) -> None:
        """Cron script must refuse to run if the scoped token is not set."""
        result = mupot_brain_enable(slug="acme")
        cron_script = result["cron_script"]
        # Script checks for the token env var
        assert "MUMEGA_BRAIN_TOKEN_ACME" in cron_script
        assert "not set" in cron_script or "not token" in cron_script

    def test_different_slug_produces_different_token_var(self) -> None:
        r1 = mupot_brain_enable(slug="alpha")
        r2 = mupot_brain_enable(slug="beta")
        assert r1["token_env_var"] != r2["token_env_var"]
        assert "ALPHA" in r1["token_env_var"]
        assert "BETA" in r2["token_env_var"]

    def test_hermes_home_override_propagates(self) -> None:
        result = mupot_brain_enable(slug="acme", hermes_home="/custom/hermes")
        assert "/custom/hermes" in result["profile_dir"]
        assert "/custom/hermes" in result["cron_script_path"]

    def test_invalid_slug_raises(self) -> None:
        with pytest.raises(ValueError, match="Invalid slug"):
            mupot_brain_enable(slug="ACME-INVALID")

    def test_cron_entry_is_dict_with_required_keys(self) -> None:
        result = mupot_brain_enable(slug="acme")
        entry = result["cron_entry"]
        assert isinstance(entry, dict)
        assert "name" in entry
        assert "schedule" in entry
        assert "command" in entry
        assert "profile" in entry
        assert entry["enabled"] is True


# ── register() wiring test ───────────────────────────────────────────────────


class TestPluginRegister:
    def _make_ctx(self) -> MagicMock:
        ctx = MagicMock()
        ctx.register_tool = MagicMock()
        ctx.on = MagicMock()
        ctx.inject_message = MagicMock()
        return ctx

    def test_register_wires_all_three_tools(self) -> None:
        from plugin import register

        ctx = self._make_ctx()
        register(ctx)

        registered_names = [
            call.args[0] if call.args else call.kwargs.get("name")
            for call in ctx.register_tool.call_args_list
        ]
        assert "mupot_provision" in registered_names
        assert "mupot_status" in registered_names
        assert "mupot_brain_enable" in registered_names

    def test_register_wires_on_session_start_hook(self) -> None:
        from plugin import register

        ctx = self._make_ctx()
        register(ctx)

        hook_names = [
            call.args[0] if call.args else call.kwargs.get("name", call.args)
            for call in ctx.on.call_args_list
        ]
        # ctx.on("on_session_start", handler) → first arg is event name
        first_args = [call.args[0] for call in ctx.on.call_args_list]
        assert "on_session_start" in first_args

    def test_on_session_start_injects_reminder_when_no_account_id(self) -> None:
        from plugin import register
        import os

        ctx = self._make_ctx()
        register(ctx)

        # Extract the registered hook handler
        handler = ctx.on.call_args_list[0].args[1]

        session = MagicMock()
        session.id = "test-session-001"

        with patch.dict(os.environ, {}, clear=True):
            # Ensure MUPOT_CF_ACCOUNT_ID is not set
            os.environ.pop("MUPOT_CF_ACCOUNT_ID", None)
            handler(session)

        ctx.inject_message.assert_called_once()
        msg = ctx.inject_message.call_args.args[0]
        assert "mupot_provision" in msg

    def test_on_session_start_no_reminder_when_account_id_set(self) -> None:
        from plugin import register
        import os

        ctx = self._make_ctx()
        register(ctx)

        handler = ctx.on.call_args_list[0].args[1]

        session = MagicMock()
        session.id = "test-session-002"

        with patch.dict(os.environ, {"MUPOT_CF_ACCOUNT_ID": "a" * 32}):
            handler(session)

        ctx.inject_message.assert_not_called()

    def test_on_session_start_fires_only_once_per_session(self) -> None:
        from plugin import register
        import os

        ctx = self._make_ctx()
        register(ctx)

        handler = ctx.on.call_args_list[0].args[1]

        session = MagicMock()
        session.id = "test-session-003"

        with patch.dict(os.environ, {}, clear=True):
            os.environ.pop("MUPOT_CF_ACCOUNT_ID", None)
            handler(session)
            handler(session)  # second call same session — must not fire again

        # inject_message called exactly once (not twice)
        assert ctx.inject_message.call_count == 1
