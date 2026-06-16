"""
mupot Hermes Plugin — register(ctx) entry point.

Hermes calls register(ctx) once on plugin load. ctx is the PluginContext
(or a duck-typed test stand-in) that exposes .register_tool() and .on().
"""

from __future__ import annotations

import os
from typing import Any

from .schemas import (
    MUPOT_BRAIN_ENABLE_SCHEMA,
    MUPOT_PROVISION_SCHEMA,
    MUPOT_STATUS_SCHEMA,
)
from .tools import mupot_brain_enable, mupot_provision, mupot_status


def register(ctx: Any) -> None:
    """
    Wire the 3 mupot tools and the on_session_start hook into the Hermes ctx.

    ctx must support:
      ctx.register_tool(name, fn, schema, description)
      ctx.on(event_name, handler)
    """

    # ── Tool registrations ───────────────────────────────────────────────────

    ctx.register_tool(
        name="mupot_provision",
        fn=mupot_provision,
        schema=MUPOT_PROVISION_SCHEMA,
        description=(
            "v0.1 PLAN-ONLY: emit an idempotent plan + exact wrangler CLI commands to "
            "provision a mupot instance (D1 + KV + wrangler toml). Does NOT call the "
            "Cloudflare API directly — run the emitted commands yourself. Real auto-apply "
            "lands in v0.2. Never runs migrations automatically (Risk 2: drift landmine)."
        ),
    )

    ctx.register_tool(
        name="mupot_status",
        fn=mupot_status,
        schema=MUPOT_STATUS_SCHEMA,
        description="Probe a live mupot /health endpoint. Returns {ok, tenant, url}.",
    )

    ctx.register_tool(
        name="mupot_brain_enable",
        fn=mupot_brain_enable,
        schema=MUPOT_BRAIN_ENABLE_SCHEMA,
        description=(
            "Emit the steps to wire the DMN brain for a provisioned mupot pot: "
            "profile + config.yaml (qwen3.7-plus) + real-file cron + scoped token. "
            "v0.1 emits a plan; does not execute against a live host."
        ),
    )

    # ── on_session_start hook ────────────────────────────────────────────────

    _session_reminded: set[str] = set()

    def _on_session_start(session: Any) -> None:
        """
        Check if MUPOT_CF_ACCOUNT_ID is configured.
        If not, inject a one-time reminder that mupot_provision is available.
        The reminder fires at most once per session (tracked by session id).
        """
        session_id = getattr(session, "id", "default")
        if session_id in _session_reminded:
            return

        account_id = os.environ.get("MUPOT_CF_ACCOUNT_ID", "").strip()
        if not account_id:
            reminder = (
                "[mupot] No Cloudflare account connected. "
                "Run `mupot_provision` to set up your own mupot instance on Cloudflare. "
                "You'll need a scoped CF API token — see README.md for the token-template link."
            )
            # ctx.inject_message is the Hermes API for surfacing plugin messages
            if hasattr(ctx, "inject_message"):
                ctx.inject_message(reminder, level="info")

        _session_reminded.add(session_id)

    ctx.on("on_session_start", _on_session_start)
