# Cursor Background Agents — BYOA install pack (topology C)

Vendor-hosted cloud agent (beta). mupot launches via `POST api.cursor.com/v1/agents`,
the runtime attaches back over signed `fleet-attach:v1`, and completion arrives on the
HMAC webhook (`statusChange`) or poll.

## Credential

1. `create_agent` → `mint_agent_token` (welds identity; least-privilege squad grant).
2. Generate Ed25519 on the host; `register_agent_key` with the public `x` only.
3. Fill `attach.env.template` (never commit secrets).

Work always lands at `review`. Do not rely on API-spawned agents posting PR comments
until validated (known beta risk).

See docs/byoa-customer-onboarding.md.
