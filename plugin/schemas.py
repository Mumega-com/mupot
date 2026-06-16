"""
JSON Schema definitions for the 3 mupot plugin tools.
Each schema is a dict compatible with JSON Schema Draft-7 / OpenAI tool calling.
"""

MUPOT_PROVISION_SCHEMA = {
    "type": "object",
    "description": (
        "v0.1 PLAN-ONLY: emit an idempotent plan + exact wrangler CLI commands to "
        "provision a mupot instance on Cloudflare. Does NOT call the Cloudflare API "
        "directly — run the emitted commands yourself. Real auto-apply in v0.2."
    ),
    "properties": {
        "slug": {
            "type": "string",
            "pattern": r"^[a-z0-9][a-z0-9-]{0,28}[a-z0-9]$",
            "description": (
                "Your pot slug: lowercase alphanumeric + hyphens, 2–30 chars, "
                "no leading/trailing hyphen. Used in mupot-<slug>.workers.dev."
            ),
        },
        "brand": {
            "type": "string",
            "minLength": 1,
            "maxLength": 64,
            "description": "Display brand name shown in the dashboard (e.g. 'Acme Corp').",
        },
        "cf_account_id": {
            "type": "string",
            "minLength": 32,
            "maxLength": 32,
            "pattern": r"^[a-f0-9]{32}$",
            "description": "Your Cloudflare account ID (32 hex chars).",
        },
        "cf_api_token": {
            "type": "string",
            "minLength": 32,
            "description": (
                "Scoped CF API token. Minimum: Workers Scripts:Edit, D1:Edit, "
                "Workers KV Storage:Edit, Account Settings:Read. "
                "NEVER log this value."
            ),
        },
        "oauth_provider": {
            "type": "string",
            "enum": ["google", "telegram"],
            "default": "google",
            "description": "OAuth identity provider for the dashboard login.",
        },
        "confirm": {
            "type": "boolean",
            "default": False,
            "description": (
                "v0.1: confirm=True returns the same plan-only response — no live CF "
                "calls are made without the bundled SDK client (coming in v0.2). "
                "In v0.2+, confirm=True will create CF resources. "
                "NEVER apply without reviewing dry-run output first (Risk 2: drift landmine)."
            ),
        },
        "dry_run": {
            "type": "boolean",
            "default": True,
            "description": (
                "Alias for confirm=false. Explicit dry_run=true forces dry-run "
                "even if confirm=true (dry_run takes precedence as a safety guard)."
            ),
        },
    },
    "required": ["slug", "brand", "cf_account_id", "cf_api_token"],
    "additionalProperties": False,
}

MUPOT_STATUS_SCHEMA = {
    "type": "object",
    "description": "Probe a live mupot deployment's /health endpoint.",
    "properties": {
        "url": {
            "type": "string",
            "format": "uri",
            "description": (
                "Base URL of the mupot deployment, e.g. "
                "'https://mupot-acme.workers.dev' or a custom domain."
            ),
        },
    },
    "required": ["url"],
    "additionalProperties": False,
}

MUPOT_BRAIN_ENABLE_SCHEMA = {
    "type": "object",
    "description": (
        "Emit the steps to wire an idempotent DMN brain for a provisioned mupot slug. "
        "v0.1 emits the plan + commands; does NOT execute against a live host."
    ),
    "properties": {
        "slug": {
            "type": "string",
            "pattern": r"^[a-z0-9][a-z0-9-]{0,28}[a-z0-9]$",
            "description": "The same slug used in mupot_provision.",
        },
        "hermes_home": {
            "type": "string",
            "description": (
                "Path to the Hermes home directory on the target machine. "
                "Default: ~/.hermes"
            ),
            "default": "~/.hermes",
        },
        "openrouter_api_key_env": {
            "type": "string",
            "description": (
                "Name of the env var holding the OpenRouter API key for qwen3.7-plus. "
                "Default: OPENROUTER_API_KEY"
            ),
            "default": "OPENROUTER_API_KEY",
        },
    },
    "required": ["slug"],
    "additionalProperties": False,
}
