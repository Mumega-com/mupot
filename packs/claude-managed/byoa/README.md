# Claude Managed Agents — BYOA install pack (topology C)

Anthropic-hosted sandbox. Launch via Managed Agents REST; completion is **poll/SSE only**
(no webhook). Attach back over signed `fleet-attach:v1`.

## Credential

1. `create_agent` → `mint_agent_token`.
2. `register_agent_key` with host Ed25519 public `x`.
3. Fill `attach.env.template`.

Land at `review`. Beta: not eligible for ZDR/HIPAA BAA while in preview.

See docs/byoa-customer-onboarding.md.
