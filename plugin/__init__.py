"""Mupot Hermes backend plugin entry point.

The plugin has two intentionally separate modes:

* ``provisioner`` keeps the human-controlled Cloudflare setup tools.
* ``operator`` registers only the restricted, agent-bound Mupot action wrappers.

A single Hermes profile never receives both surfaces.  DME production uses
``operator`` mode; provisioning belongs in a separate human-controlled profile.
"""

from __future__ import annotations

import json
import os
from typing import Any, Mapping

from .operator import MupotOperatorClient, OperatorSettings, register_operator_tools
from .schemas import (
    MUPOT_BRAIN_ENABLE_SCHEMA,
    MUPOT_PROVISION_SCHEMA,
    MUPOT_STATUS_SCHEMA,
)
from .tools import mupot_brain_enable, mupot_provision, mupot_status


def _load_plugin_settings() -> dict[str, Any]:
    """Load non-secret Mupot settings from the active Hermes profile."""

    try:
        from hermes_cli.config import cfg_get, load_config

        config = load_config()
        value = cfg_get(config, "plugins", "entries", "mupot", "settings", default={})
        if not isinstance(value, Mapping):
            raise ValueError("plugins.entries.mupot.settings must be a mapping")
        return dict(value)
    except (ImportError, OSError, TypeError, ValueError) as exc:
        raise RuntimeError("unable to load Mupot plugin settings; no tools were registered") from exc


def _tool_schema(name: str, description: str, parameters: dict[str, Any]) -> dict[str, Any]:
    return {"name": name, "description": description, "parameters": parameters}


def _result(value: Any) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, default=str)


def _register_provisioner_tools(ctx: Any) -> None:
    """Register the legacy human-controlled setup surface using the current API."""

    def provision(args: dict[str, Any]) -> str:
        values = dict(args)
        values.setdefault("cf_account_id", os.environ.get("MUPOT_CF_ACCOUNT_ID", ""))
        values.setdefault("cf_api_token", os.environ.get("MUPOT_CF_API_TOKEN", ""))
        return _result(mupot_provision(**values))

    def status(args: dict[str, Any]) -> str:
        return _result(mupot_status(**args))

    def brain_enable(args: dict[str, Any]) -> str:
        return _result(mupot_brain_enable(**args))

    registrations = (
        (
            "mupot_provision",
            provision,
            MUPOT_PROVISION_SCHEMA,
            "Idempotently plan or provision a human-owned Mupot Cloudflare deployment.",
        ),
        (
            "mupot_status",
            status,
            MUPOT_STATUS_SCHEMA,
            "Probe a Mupot deployment health endpoint.",
        ),
        (
            "mupot_brain_enable",
            brain_enable,
            MUPOT_BRAIN_ENABLE_SCHEMA,
            "Plan a Mupot DMN brain profile and schedule.",
        ),
    )
    for name, handler, parameters, description in registrations:
        ctx.register_tool(
            name=name,
            handler=handler,
            schema=_tool_schema(name, description, parameters),
            toolset="mupot-provisioner",
        )


def _register_provisioner_reminder(ctx: Any) -> None:
    reminded: set[str] = set()

    def on_session_start(event: Any) -> None:
        session_id = str(getattr(event, "session_id", getattr(event, "id", "default")))
        if session_id in reminded:
            return
        reminded.add(session_id)
        if os.environ.get("MUPOT_CF_ACCOUNT_ID", "").strip():
            return
        inject = getattr(ctx, "inject_message", None)
        if callable(inject):
            inject(
                "[mupot] Provisioner mode is active, but no Cloudflare account is configured. "
                "Use mupot_provision after supplying a scoped Cloudflare credential."
            )

    register_hook = getattr(ctx, "register_hook", None)
    if callable(register_hook):
        register_hook("on_session_start", on_session_start)
    legacy_on = getattr(ctx, "on", None)
    if callable(legacy_on):
        legacy_on("on_session_start", on_session_start)


def register(ctx: Any) -> None:
    settings = _load_plugin_settings()
    configured_mode = settings.get("mode") or os.environ.get("MUPOT_PLUGIN_MODE")
    if not isinstance(configured_mode, str) or not configured_mode.strip():
        raise ValueError("Mupot plugin mode must be explicitly set to 'operator' or 'provisioner'")
    mode = configured_mode.strip().lower()

    if mode == "operator":
        operator_value = settings.get("operator", settings)
        if not isinstance(operator_value, Mapping):
            raise ValueError("plugins.entries.mupot.settings.operator must be a mapping")
        operator_settings = OperatorSettings.from_mapping(operator_value)
        token = os.environ.get("MUPOT_AGENT_TOKEN", "")
        client = MupotOperatorClient(operator_settings, token=token)
        register_operator_tools(ctx, client)
        return

    if mode == "provisioner":
        _register_provisioner_tools(ctx)
        _register_provisioner_reminder(ctx)
        return

    raise ValueError("Mupot plugin mode must be 'operator' or 'provisioner'")
