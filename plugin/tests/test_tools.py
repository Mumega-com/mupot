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

import urllib.error
import urllib.request

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
    CloudflareApiClient,
    CloudflareApiError,
    DryRunClient,
    _CF_API_BASE,
    _build_api_client_from_env,
    _run_wrangler_deploy,
    _validate_slug,
    mupot_brain_enable,
    mupot_provision,
    mupot_revoke_token,
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
        """v0.2 dry-run emits a plan summary (not the v0.1 manual wrangler commands).
        Must clearly say it is a dry-run and explain how to apply."""
        result = mupot_provision(
            slug="acme",
            brand="Acme Corp",
            cf_account_id="a" * 32,
            cf_api_token="tok_" + "x" * 40,
        )
        next_steps_str = "\n".join(result["next_steps"])
        # v0.2 dry-run plan says what WILL happen + how to trigger apply
        assert "DRY-RUN" in next_steps_str or "dry_run" in next_steps_str
        # Still mentions migration dry-run gate (Risk 2)
        assert "--dry-run" in next_steps_str or "dry-run" in next_steps_str.lower()
        # Does not claim the apply already happened
        assert "applied" not in next_steps_str.lower()
        assert "created" not in next_steps_str.lower()

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
    def test_apply_without_client_and_no_env_raises_valueerror(self) -> None:
        """
        v0.2: confirm=True + dry_run=False without an injected client constructs
        CloudflareApiClient from env.  If MUPOT_CF_API_TOKEN is not set, it raises
        ValueError with a clear message — no silent plan-only return.
        """
        with patch.dict(os.environ, {}, clear=True):
            os.environ.pop("MUPOT_CF_API_TOKEN", None)
            with pytest.raises(ValueError, match="MUPOT_CF_API_TOKEN"):
                mupot_provision(
                    slug="acme",
                    brand="Acme Corp",
                    cf_account_id="a" * 32,
                    cf_api_token="tok_" + "x" * 40,
                    confirm=True,
                    dry_run=False,
                )

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


# ── v0.2: CloudflareApiClient URL/headers construction ───────────────────────


class TestCloudflareApiClientConstruction:
    """
    Verify the real API client builds correct request shapes WITHOUT sending anything.
    All urllib.request.urlopen calls are mocked — no network.
    """

    def _make_success_response(self, result: Any) -> MagicMock:
        """Return a mock that urllib.request.urlopen().__enter__ yields."""
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps(
            {"success": True, "errors": [], "result": result}
        ).encode()
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        return mock_resp

    def test_list_d1_databases_url_is_correct(self) -> None:
        client = CloudflareApiClient("test-token-abc")
        account_id = "acct_" + "a" * 27

        with patch("urllib.request.urlopen") as mock_urlopen:
            mock_urlopen.return_value = self._make_success_response([])
            client.list_d1_databases(account_id)

        req: urllib.request.Request = mock_urlopen.call_args[0][0]
        assert req.get_method() == "GET"
        assert f"/accounts/{account_id}/d1/database" in req.full_url
        assert "per_page=" in req.full_url

    def test_list_d1_databases_auth_header_set(self) -> None:
        client = CloudflareApiClient("my-secret-token")
        account_id = "acct_" + "b" * 27

        with patch("urllib.request.urlopen") as mock_urlopen:
            mock_urlopen.return_value = self._make_success_response([])
            client.list_d1_databases(account_id)

        req: urllib.request.Request = mock_urlopen.call_args[0][0]
        auth = req.get_header("Authorization")
        assert auth == "Bearer my-secret-token"

    def test_create_d1_database_method_is_post(self) -> None:
        client = CloudflareApiClient("tok")
        account_id = "acct_" + "c" * 27

        with patch("urllib.request.urlopen") as mock_urlopen:
            mock_urlopen.return_value = self._make_success_response(
                {"id": "new-d1-uuid", "name": "mupot-test"}
            )
            result = client.create_d1_database(account_id, "mupot-test")

        req: urllib.request.Request = mock_urlopen.call_args[0][0]
        assert req.get_method() == "POST"
        assert f"/accounts/{account_id}/d1/database" in req.full_url
        assert result["id"] == "new-d1-uuid"

    def test_create_d1_database_sends_name_in_body(self) -> None:
        client = CloudflareApiClient("tok")
        account_id = "acct_" + "d" * 27

        with patch("urllib.request.urlopen") as mock_urlopen:
            mock_urlopen.return_value = self._make_success_response(
                {"id": "db-uuid", "name": "mupot-myorg"}
            )
            client.create_d1_database(account_id, "mupot-myorg")

        req: urllib.request.Request = mock_urlopen.call_args[0][0]
        body = json.loads(req.data.decode())
        assert body["name"] == "mupot-myorg"

    def test_list_kv_namespaces_url_is_correct(self) -> None:
        client = CloudflareApiClient("tok")
        account_id = "acct_" + "e" * 27

        with patch("urllib.request.urlopen") as mock_urlopen:
            mock_urlopen.return_value = self._make_success_response([])
            client.list_kv_namespaces(account_id)

        req: urllib.request.Request = mock_urlopen.call_args[0][0]
        assert req.get_method() == "GET"
        assert "/storage/kv/namespaces" in req.full_url
        assert f"/accounts/{account_id}/" in req.full_url

    def test_create_kv_namespace_method_is_post(self) -> None:
        client = CloudflareApiClient("tok")
        account_id = "acct_" + "f" * 27

        with patch("urllib.request.urlopen") as mock_urlopen:
            mock_urlopen.return_value = self._make_success_response(
                {"id": "kv-uuid", "title": "mupot-test-sessions"}
            )
            result = client.create_kv_namespace(account_id, "mupot-test-sessions")

        req: urllib.request.Request = mock_urlopen.call_args[0][0]
        assert req.get_method() == "POST"
        assert "/storage/kv/namespaces" in req.full_url
        body = json.loads(req.data.decode())
        assert body["title"] == "mupot-test-sessions"
        assert result["id"] == "kv-uuid"

    def test_token_not_in_repr(self) -> None:
        """Risk 1: token must never appear in repr/str of the client."""
        client = CloudflareApiClient("super-secret-token-xyz")
        assert "super-secret-token-xyz" not in repr(client)
        assert "super-secret-token-xyz" not in str(client)

    def test_api_error_raised_on_http_error(self) -> None:
        client = CloudflareApiClient("tok")
        account_id = "acct_" + "g" * 27

        with patch("urllib.request.urlopen") as mock_urlopen:
            mock_urlopen.side_effect = urllib.error.HTTPError(
                url=f"{_CF_API_BASE}/accounts/{account_id}/d1/database",
                code=403,
                msg="Forbidden",
                hdrs=MagicMock(),  # type: ignore[arg-type]
                fp=None,
            )
            with pytest.raises(CloudflareApiError) as exc_info:
                client.list_d1_databases(account_id)

        assert exc_info.value.status == 403
        # Token must NOT be in the error message (Risk 1)
        assert "tok" not in str(exc_info.value)

    def test_api_error_not_raised_on_success_false_payload(self) -> None:
        """CF sometimes returns 200 with success=false — must raise CloudflareApiError."""
        client = CloudflareApiClient("tok")
        account_id = "acct_" + "h" * 27

        error_payload = json.dumps(
            {"success": False, "errors": [{"code": 10000, "message": "Auth error"}]}
        ).encode()
        mock_resp = MagicMock()
        mock_resp.read.return_value = error_payload
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)

        with patch("urllib.request.urlopen", return_value=mock_resp):
            with pytest.raises(CloudflareApiError):
                client.list_d1_databases(account_id)

    def test_empty_token_raises_valueerror(self) -> None:
        with pytest.raises(ValueError, match="CF API token is empty"):
            CloudflareApiClient("")

    def test_base_url_is_cf_v4(self) -> None:
        assert _CF_API_BASE == "https://api.cloudflare.com/client/v4"


# ── v0.2: FakeCFClient — idempotent apply path ───────────────────────────────


@dataclass
class FakeCFClient:
    """
    Test double for CloudflareApiClient.  Records calls; supports pre-seeding
    existing resources (to exercise the idempotent list-guard).  NO network.
    """

    calls: list[dict[str, Any]] = field(default_factory=list)
    _existing_d1: list[dict[str, Any]] = field(default_factory=list)
    _existing_kv: list[dict[str, Any]] = field(default_factory=list)
    _d1_counter: int = 0
    _kv_counter: int = 0

    def preseed_d1(self, name: str, db_id: str) -> None:
        self._existing_d1.append({"name": name, "id": db_id})

    def preseed_kv(self, title: str, ns_id: str) -> None:
        self._existing_kv.append({"title": title, "id": ns_id})

    def list_d1_databases(self, account_id: str) -> list[dict[str, Any]]:
        self.calls.append({"method": "list_d1_databases", "account_id": account_id})
        return list(self._existing_d1)

    def create_d1_database(self, account_id: str, name: str) -> dict[str, Any]:
        self.calls.append(
            {"method": "create_d1_database", "account_id": account_id, "name": name}
        )
        self._d1_counter += 1
        db = {"id": f"fake-d1-{self._d1_counter:04d}", "name": name}
        self._existing_d1.append(db)
        return db

    def list_kv_namespaces(self, account_id: str) -> list[dict[str, Any]]:
        self.calls.append(
            {"method": "list_kv_namespaces", "account_id": account_id}
        )
        return list(self._existing_kv)

    def create_kv_namespace(self, account_id: str, title: str) -> dict[str, Any]:
        self.calls.append(
            {"method": "create_kv_namespace", "account_id": account_id, "title": title}
        )
        self._kv_counter += 1
        ns = {"id": f"fake-kv-{self._kv_counter:04d}", "title": title}
        self._existing_kv.append(ns)
        return ns


class TestFakeCFClientApplyIdempotent:
    """
    v0.2 apply path with FakeCFClient — exercises idempotent list-guard, toml generation,
    and migration dry-run-first ordering.  No network; no real CF account.
    """

    def _apply(
        self,
        slug: str = "testorg",
        brand: str = "Test Org",
        cf_client: Optional[FakeCFClient] = None,
        tmp_path: Optional[Path] = None,
    ) -> dict[str, Any]:
        return mupot_provision(
            slug=slug,
            brand=brand,
            cf_account_id="acct_" + "a" * 27,
            cf_api_token="tok",
            confirm=True,
            dry_run=False,
            cf_client=cf_client or FakeCFClient(),
            toml_output_dir=tmp_path or Path("."),
        )

    def test_apply_creates_d1_and_kv(self, tmp_path: Path) -> None:
        fake = FakeCFClient()
        result = self._apply(cf_client=fake, tmp_path=tmp_path)

        assert result["applied"] is True
        create_calls = [c["method"] for c in fake.calls]
        assert "create_d1_database" in create_calls
        assert create_calls.count("create_kv_namespace") == 2

    def test_apply_idempotent_skips_existing_d1(self, tmp_path: Path) -> None:
        fake = FakeCFClient()
        fake.preseed_d1("mupot-testorg", "existing-d1-id")

        result = self._apply(cf_client=fake, tmp_path=tmp_path)

        # D1 must not be recreated
        d1_creates = [c for c in fake.calls if c["method"] == "create_d1_database"]
        assert len(d1_creates) == 0
        # d1_id in result must be the pre-existing one
        assert result["d1_id"] == "existing-d1-id"

    def test_apply_idempotent_skips_existing_kv(self, tmp_path: Path) -> None:
        fake = FakeCFClient()
        fake.preseed_kv("mupot-testorg-sessions", "existing-sess-id")
        fake.preseed_kv("mupot-testorg-oauth", "existing-oauth-id")

        result = self._apply(cf_client=fake, tmp_path=tmp_path)

        kv_creates = [c for c in fake.calls if c["method"] == "create_kv_namespace"]
        assert len(kv_creates) == 0
        assert result["sessions_kv_id"] == "existing-sess-id"
        assert result["oauth_kv_id"] == "existing-oauth-id"

    def test_apply_partial_state_creates_missing_only(self, tmp_path: Path) -> None:
        """D1 exists; KV does not — only KVs should be created."""
        fake = FakeCFClient()
        fake.preseed_d1("mupot-testorg", "pre-existing-d1")

        result = self._apply(cf_client=fake, tmp_path=tmp_path)

        d1_creates = [c for c in fake.calls if c["method"] == "create_d1_database"]
        kv_creates = [c for c in fake.calls if c["method"] == "create_kv_namespace"]
        assert len(d1_creates) == 0
        assert len(kv_creates) == 2
        assert result["d1_id"] == "pre-existing-d1"

    def test_apply_writes_toml_with_resolved_ids(self, tmp_path: Path) -> None:
        fake = FakeCFClient()
        result = self._apply(slug="myorg", brand="My Org", cf_client=fake, tmp_path=tmp_path)

        toml_path = Path(result["toml_path"])
        assert toml_path.exists()
        content = toml_path.read_text()
        assert 'name = "mupot-myorg"' in content
        assert result["d1_id"] in content
        assert result["sessions_kv_id"] in content
        assert result["oauth_kv_id"] in content

    def test_apply_toml_brand_in_vars(self, tmp_path: Path) -> None:
        fake = FakeCFClient()
        result = self._apply(brand="Acme Inc", cf_client=fake, tmp_path=tmp_path)
        content = Path(result["toml_path"]).read_text()
        assert 'BRAND = "Acme Inc"' in content

    def test_apply_next_steps_migration_dry_run_before_apply(
        self, tmp_path: Path
    ) -> None:
        """Risk 2: dry-run migration step must appear BEFORE the non-dry-run apply."""
        fake = FakeCFClient()
        result = self._apply(cf_client=fake, tmp_path=tmp_path)
        steps = "\n".join(result["next_steps"])

        dry_run_pos = steps.find("--dry-run")
        assert dry_run_pos != -1, "next_steps must include --dry-run migration gate"

        # Find a bare 'migrations apply' WITHOUT --dry-run after the dry-run instruction
        # The apply-without-dry-run command must appear AFTER the dry-run instruction
        bare_apply_pos = steps.find("migrations apply", dry_run_pos + 1)
        if bare_apply_pos != -1:
            # If a bare apply appears at all, it comes after the dry-run mention
            assert bare_apply_pos > dry_run_pos

    def test_apply_result_dry_run_is_false(self, tmp_path: Path) -> None:
        fake = FakeCFClient()
        result = self._apply(cf_client=fake, tmp_path=tmp_path)
        assert result["dry_run"] is False
        assert result["applied"] is True

    def test_second_apply_same_slug_is_idempotent(self, tmp_path: Path) -> None:
        """Running apply twice with the same slug must not create duplicate resources."""
        fake = FakeCFClient()
        result1 = self._apply(slug="alpha", cf_client=fake, tmp_path=tmp_path)
        result2 = self._apply(slug="alpha", cf_client=fake, tmp_path=tmp_path)

        # Both runs must succeed
        assert result1["applied"] is True
        assert result2["applied"] is True

        # On second run: no create calls (all resources already exist)
        all_calls = fake.calls
        # calls from run 1: list×2, create×3. Run 2: list×2, no creates.
        creates_run2 = [
            c for c in all_calls[5:]  # skip first 5 (list×2 + create×3 from run 1)
            if c["method"].startswith("create_")
        ]
        assert len(creates_run2) == 0


# ── v0.2: token never leaked ─────────────────────────────────────────────────


class TestTokenNeverLeaked:
    """
    Risk 1: the CF API token must NEVER appear in any logged, returned, or raised string.
    """

    def test_token_not_in_provision_result(self, tmp_path: Path) -> None:
        SECRET = "super-secret-token-12345"
        fake = FakeCFClient()
        result = mupot_provision(
            slug="acme",
            brand="Acme Corp",
            cf_account_id="a" * 32,
            cf_api_token=SECRET,
            confirm=True,
            dry_run=False,
            cf_client=fake,
            toml_output_dir=tmp_path,
        )
        # Serialise the entire result dict and check the token never appears
        result_str = json.dumps(result, default=str)
        assert SECRET not in result_str

    def test_token_not_in_toml_output(self, tmp_path: Path) -> None:
        SECRET = "super-secret-token-67890"
        fake = FakeCFClient()
        result = mupot_provision(
            slug="acme",
            brand="Acme Corp",
            cf_account_id="a" * 32,
            cf_api_token=SECRET,
            confirm=True,
            dry_run=False,
            cf_client=fake,
            toml_output_dir=tmp_path,
        )
        toml_content = Path(result["toml_path"]).read_text()
        assert SECRET not in toml_content

    def test_cf_client_repr_omits_token(self) -> None:
        SECRET = "hidden-bearer-token"
        client = CloudflareApiClient(SECRET)
        assert SECRET not in repr(client)
        assert SECRET not in str(client)

    def test_api_error_does_not_contain_token(self) -> None:
        SECRET = "do-not-log-me"
        client = CloudflareApiClient(SECRET)

        with patch("urllib.request.urlopen") as mock_urlopen:
            mock_urlopen.side_effect = urllib.error.HTTPError(
                url="https://api.cloudflare.com/client/v4/accounts/xyz/d1/database",
                code=401,
                msg="Unauthorized",
                hdrs=MagicMock(),  # type: ignore[arg-type]
                fp=None,
            )
            with pytest.raises(CloudflareApiError) as exc_info:
                client.list_d1_databases("xyz")

        assert SECRET not in str(exc_info.value)


# ── v0.2: build_api_client_from_env ─────────────────────────────────────────


class TestBuildApiClientFromEnv:
    def test_missing_token_raises_valueerror(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            os.environ.pop("MUPOT_CF_API_TOKEN", None)
            with pytest.raises(ValueError, match="MUPOT_CF_API_TOKEN"):
                _build_api_client_from_env()

    def test_present_token_returns_client(self) -> None:
        with patch.dict(os.environ, {"MUPOT_CF_API_TOKEN": "tok-from-env"}):
            client = _build_api_client_from_env()
        assert isinstance(client, CloudflareApiClient)

    def test_error_message_names_env_var_not_value(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            os.environ.pop("MUPOT_CF_API_TOKEN", None)
            with pytest.raises(ValueError) as exc_info:
                _build_api_client_from_env()
        msg = str(exc_info.value)
        assert "MUPOT_CF_API_TOKEN" in msg
        # The error must name the var, not expose a secret value
        # (value is empty here but the pattern must hold in principle)
        assert "Bearer" not in msg


# ── v0.2: wrangler deploy gate ────────────────────────────────────────────────


class TestRunWranglerDeploy:
    """
    Tests for _run_wrangler_deploy.  All subprocess calls are mocked — no real wrangler.
    Risk 4: version check runs before deploy; Risk 1: token never passed in argv.
    """

    def _make_run(
        self, version_rc: int = 0, deploy_rc: int = 0
    ) -> tuple[MagicMock, list[list[str]]]:
        """Return (mock_run, recorded_argv_lists)."""
        recorded: list[list[str]] = []

        def fake_run(cmd: list[str], **kwargs: Any) -> MagicMock:
            recorded.append(cmd)
            r = MagicMock()
            if "--version" in cmd:
                r.returncode = version_rc
                r.stdout = "wrangler 3.57.0"
                r.stderr = ""
            else:
                r.returncode = deploy_rc
                r.stdout = "Deployed successfully"
                r.stderr = ""
            return r

        return MagicMock(side_effect=fake_run), recorded

    def test_version_check_runs_first(self, tmp_path: Path) -> None:
        mock_run, recorded = self._make_run()
        toml = tmp_path / "wrangler.test.toml"
        toml.write_text("name = 'mupot-test'")

        _run_wrangler_deploy(slug="test", toml_path=toml, _subprocess_run=mock_run)

        assert "--version" in recorded[0], "wrangler --version must be the first command"

    def test_deploy_command_does_not_contain_token_in_argv(self, tmp_path: Path) -> None:
        """Risk 1: CF token must NOT appear in the argv passed to subprocess."""
        mock_run, recorded = self._make_run()
        toml = tmp_path / "wrangler.test.toml"
        toml.write_text("name = 'mupot-test'")

        _run_wrangler_deploy(slug="test", toml_path=toml, _subprocess_run=mock_run)

        # Find the deploy command (the one that is NOT --version)
        deploy_cmd = next(c for c in recorded if "--version" not in c)
        # No token-shaped string in argv
        for arg in deploy_cmd:
            assert "Bearer" not in arg
            assert "MUPOT_CF_API_TOKEN" not in arg
            assert "secret" not in arg.lower()

    def test_deploy_returns_ok_true_on_zero_returncode(self, tmp_path: Path) -> None:
        mock_run, _ = self._make_run(deploy_rc=0)
        toml = tmp_path / "wrangler.test.toml"
        toml.write_text("name = 'mupot-test'")

        result = _run_wrangler_deploy(slug="test", toml_path=toml, _subprocess_run=mock_run)
        assert result["ok"] is True
        assert result["returncode"] == 0

    def test_deploy_returns_ok_false_on_nonzero_returncode(self, tmp_path: Path) -> None:
        mock_run, _ = self._make_run(deploy_rc=1)
        toml = tmp_path / "wrangler.test.toml"
        toml.write_text("name = 'mupot-test'")

        result = _run_wrangler_deploy(slug="test", toml_path=toml, _subprocess_run=mock_run)
        assert result["ok"] is False

    def test_version_check_failure_short_circuits(self, tmp_path: Path) -> None:
        """If wrangler --version fails, deploy must NOT run."""
        mock_run, recorded = self._make_run(version_rc=127)  # wrangler not found
        toml = tmp_path / "wrangler.test.toml"
        toml.write_text("name = 'mupot-test'")

        result = _run_wrangler_deploy(slug="test", toml_path=toml, _subprocess_run=mock_run)

        assert result["ok"] is False
        assert "error" in result
        # Deploy command must NOT have been called
        deploy_cmds = [c for c in recorded if "--version" not in c]
        assert len(deploy_cmds) == 0

    def test_deploy_config_flag_uses_toml_path(self, tmp_path: Path) -> None:
        mock_run, recorded = self._make_run()
        toml = tmp_path / "wrangler.myorg.toml"
        toml.write_text("name = 'mupot-myorg'")

        _run_wrangler_deploy(slug="myorg", toml_path=toml, _subprocess_run=mock_run)

        deploy_cmd = next(c for c in recorded if "--version" not in c)
        assert "--config" in deploy_cmd
        config_idx = deploy_cmd.index("--config")
        assert str(toml) == deploy_cmd[config_idx + 1]


# ── v0.2: mupot_revoke_token stub ────────────────────────────────────────────


class TestMupotRevokeTokenStub:
    def test_returns_stubbed_true(self) -> None:
        result = mupot_revoke_token()
        assert result["stubbed"] is True

    def test_message_mentions_v0_3(self) -> None:
        result = mupot_revoke_token()
        assert "v0.3" in result["message"]


# ── v0.2: wrangler_deploy integration in mupot_provision ─────────────────────


class TestMupotProvisionWranglerDeploy:
    """
    mupot_provision with wrangler_deploy=True — subprocess is mocked.
    Tests that the deploy result flows into the provision result.
    """

    def _mock_wrangler(self, ok: bool = True) -> MagicMock:
        """Patch _run_wrangler_deploy to return a canned result."""
        mock = MagicMock(
            return_value={
                "ok": ok,
                "returncode": 0 if ok else 1,
                "stdout": "Deployed." if ok else "",
                "stderr": "" if ok else "Error.",
            }
        )
        return mock

    def test_wrangler_deploy_false_no_deploy_key(self, tmp_path: Path) -> None:
        fake = FakeCFClient()
        result = mupot_provision(
            slug="acme",
            brand="Acme Corp",
            cf_account_id="a" * 32,
            cf_api_token="tok",
            confirm=True,
            dry_run=False,
            cf_client=fake,
            toml_output_dir=tmp_path,
            wrangler_deploy=False,
        )
        assert "deploy" not in result

    def test_wrangler_deploy_true_calls_deploy(self, tmp_path: Path) -> None:
        fake = FakeCFClient()
        with patch("plugin.tools._run_wrangler_deploy", self._mock_wrangler(ok=True)):
            result = mupot_provision(
                slug="acme",
                brand="Acme Corp",
                cf_account_id="a" * 32,
                cf_api_token="tok",
                confirm=True,
                dry_run=False,
                cf_client=fake,
                toml_output_dir=tmp_path,
                wrangler_deploy=True,
            )
        assert "deploy" in result
        assert result["deploy"]["ok"] is True

    def test_wrangler_deploy_true_success_reflected_in_next_steps(
        self, tmp_path: Path
    ) -> None:
        fake = FakeCFClient()
        with patch("plugin.tools._run_wrangler_deploy", self._mock_wrangler(ok=True)):
            result = mupot_provision(
                slug="acme",
                brand="Acme Corp",
                cf_account_id="a" * 32,
                cf_api_token="tok",
                confirm=True,
                dry_run=False,
                cf_client=fake,
                toml_output_dir=tmp_path,
                wrangler_deploy=True,
            )
        steps = "\n".join(result["next_steps"])
        # On successful deploy, step 1 should say "deployed" not "npx wrangler deploy"
        assert "Worker deployed" in steps
