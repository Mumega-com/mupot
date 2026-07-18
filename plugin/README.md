# Mupot Hermes Plugin

Provision a [Mupot](https://github.com/Mumega-com/mupot) deployment or attach Hermes as a
restricted, agent-bound operator. Version 0.3 separates these trust zones by profile:

- `provisioner` mode: human-controlled Cloudflare setup;
- `operator` mode: a narrow Mupot task/evidence/approval-request surface, with an
  optional squad-agent manager extension.

Do not combine the modes in one Hermes profile.

## DME operator mode

The Digid × DME AI Visibility Engine uses `operator` mode. Copy
`examples/dme-hermes-config.yaml` into an isolated Hermes profile, replace the tenant,
squad and agent placeholders, and put the agent-bound secret in that profile's secret
environment:

```text
MUPOT_AGENT_TOKEN=<agent-bound-token>
```

The plugin verifies the configured tenant and welded `bound_agent_id` before work and
fails closed if the token has owner/admin ladder authority. By default it does not
register permission, credential minting, verdict, publishing, spend, outbound
communication, deletion, or generic HTTP tools. See
`../docs/dme-hermes-mupot-integration.md` and the bundled
`dme-ai-visibility-operator` skill.

### Main-Hermes squad manager extension

Only a trusted main Hermes profile should enable agent management:

```yaml
plugins:
  entries:
    mupot:
      settings:
        mode: operator
        operator:
          base_url: https://your-pot.example
          expected_tenant: your-tenant
          squad_id: squad-id
          agent_id: manager-agent-id
          approval_owner: human-owner-member-id
          pubsub_peer_agent_ids:
            - isolated-dme-agent-id
          agent_manager_enabled: true
```

Enabling the setting only registers the local tools. Mupot independently requires the
authenticated member to have both membership on that exact squad and the free-text
surface grant `agents:manage`. Before every management action, the plugin verifies its
normal welded identity and then calls the scoped `agent_manager_status` handshake. The
requested action is not sent if either proof fails.

Manager-created agents are always active `member` agents. Manager-minted credentials
are always agent-bound, squad-scoped `member` credentials; the caller cannot choose a
higher role or capability. Plaintext is returned once, hashes remain server-side, and
list results include only token IDs and non-secret metadata. Lifecycle effects write
append-only attributed audit receipts.

> **v0.2 ships the real CF provisioner.** `mupot_provision` with `confirm=True, dry_run=False`
> calls the Cloudflare API directly (pure stdlib urllib — no extra deps) to create D1 databases
> and KV namespaces, then writes `wrangler.<slug>.toml` with the resolved resource IDs.
> Default (`dry_run=True`) emits a plan without touching Cloudflare. Requires
> `MUPOT_CF_API_TOKEN` and `MUPOT_CF_ACCOUNT_ID` in the environment for apply mode.

## Install (v0.2 — published)

```bash
hermes plugins install Mumega-com/mupot-plugin
```

This directory (`mupot/plugin/`) is the **source of truth**; it is mirrored to the standalone
[Mumega-com/mupot-plugin](https://github.com/Mumega-com/mupot-plugin) repo (the Hermes install
target, tagged releases). Published 2026-06-16 at v0.2.0.

To verify the provisioner locally:

```bash
cd mupot/plugin && python3 -m pytest tests/ -v
```

### Companion CF skill tap (for Hermes users)

```bash
hermes skills install cloudflare/skills
```

### Skill-only install (Claude Code, OpenClaw, Codex, etc.)

If you don't use Hermes, drop the bundled skill anywhere your agent loads skills:

```bash
cp -r skills/mupot-operator ~/.claude/skills/
```

## Deploy to Cloudflare (no CLI)

For users who want to deploy a mupot instance directly:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Mumega-com/mupot)

*(Reads `wrangler.example.toml`, provisions bindings, deploys. Zero-code path.)*

## Tool surfaces

| Mode | Tool | What it does |
|------|------|-------------|
| provisioner | `mupot_provision` | Idempotent Cloudflare provisioner. |
| provisioner | `mupot_status` | Probe `/health` → `{ok, tenant, url}`. |
| provisioner | `mupot_brain_enable` | Plan the DMN brain profile and schedule. |
| operator | `mupot_operator_status` | Verify tenant, welded identity, and restricted privilege. |
| operator | `mupot_operator_check_in` | Record on-demand Hermes presence. |
| operator | `mupot_operator_task_board` | Read only the configured squad board. |
| operator | `mupot_operator_task_create` | Create a self-assigned scoped task. |
| operator | `mupot_operator_task_claim` | Claim permitted work as the configured identity. |
| operator | `mupot_operator_record_finding` | Record evidence while work is active or blocked. |
| operator | `mupot_operator_request_approval` | Route findings to the configured human; cannot decide the verdict. |
| operator | `mupot_operator_complete_task` | Complete ungated work; Mupot still enforces unresolved gates. |
| operator | `mupot_operator_send` | Send a durable, idempotent mailbox message to an explicitly configured peer agent. |
| operator | `mupot_operator_inbox` | Peek this welded agent's inbox; consume only when explicitly requested after acceptance. |
| manager (opt-in) | `mupot_agent_manager_list` | List configured-squad agents and non-secret token metadata. |
| manager (opt-in) | `mupot_agent_manager_create` | Create an active member agent in the configured squad. |
| manager (opt-in) | `mupot_agent_manager_set_status` | Pause or resume an agent in the configured squad. |
| manager (opt-in) | `mupot_agent_manager_mint_token` | Mint a show-once member token welded to an agent. |
| manager (opt-in) | `mupot_agent_manager_revoke_token` | Revoke an agent-bound token by ID. |

## v0.2 scope / deferred

**In v0.2 (real CF provisioner):**
- Real apply: CF REST API via pure stdlib urllib (no extra deps) — creates D1 + KV idempotently
- Idempotent list-guard: paginates all existing resources before creating (no double-create)
- `wrangler.<slug>.toml` written with resolved D1 + KV IDs after apply
- Optional `wrangler deploy` via subprocess (Risk 4: version-check gate first)
- Token security: never in argv, repr, error messages, or toml output
- Brain profile + cron plan emission (real-file cron, not symlink)
- Deploy-to-Cloudflare button

**Deferred (v0.3+):**
- CF OAuth one-click (pending Mumega OAuth app public approval)
- Full SDK provisioner (no wrangler dependency): `client.workers.scripts.update()`
- OAuth secret automation
- `hermes plugins install Mumega-com/mupot-plugin` one-liner (standalone repo publish)
- R2 / Vectorize / Queues provisioning (add via re-run)
- `mupot_revoke_token` post-provision cleanup (needs token ID at mint time)
- `pot_registry` / `pot_owners` migrations for the "Your Pots" console

## Key risks

| Risk | Mitigation |
|------|-----------|
| CF token on disk | Least-scoped token (5 groups). Rotate after provision. CF OAuth coming. |
| Migration drift | ALWAYS `--dry-run` first. Tool emits this as a required step, never auto-applies. |
| Brain token scope | Must be `task:read + priority:write` only. NOT `mcp:*`. **Operator's responsibility** — the plugin documents the requirement but cannot enforce token scope. |
| Cron symlink | Real file only. Symlink → silent non-execution. Tool template uses real file. |
| Workers slot | Free tier = 100. Tool warns near limit. Centralised Workers-for-Platforms rejected (breaks sovereignty). |

## CF API token (required for apply mode)

You need a **scoped** token — NOT your Global API Key.

Create one at:
```
https://dash.cloudflare.com/profile/api-tokens
```

Minimum permissions required:
- Workers Scripts: Edit
- D1: Edit
- Workers KV Storage: Edit
- Account Settings: Read

## Development

```bash
# Restricted operator tests use only the standard library:
python3 -m unittest -q plugin.tests.test_operator

# The complete plugin suite uses pytest in CI:
python3 -m pytest plugin/tests -v
```
