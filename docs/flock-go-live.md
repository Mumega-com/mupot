# Flock go-live — wire a pot's Fleet to the bus (operator runbook)

The Fleet code is tenant-scoped + fail-closed (Flock #43). To make a pot's `/fleet`
show its live agent roster, two operator actions remain — both need bus-admin access
(the `INTERNAL_API_SECRET`), so they're yours, not the worker's. Example: Digid.

## 1. Mint the pot's Fleet-read token

The pot reads its roster with a token scoped to its project, bound to its HQ agent
name, **read-only** (no send — outbound stays sealed; control is #46, later).

```bash
# On the bus host (has INTERNAL_API_SECRET). Mints a project=digid, read-scoped token.
curl -sX POST http://localhost:6380/api/internal/tenants/digid/agents/activate \
  -H "Authorization: Bearer $INTERNAL_API_SECRET" \
  -H 'content-type: application/json' \
  -d '{"tenant_id":"digid","tenant_slug":"digid","agent_kind":"kasra","actor_type":"platform-admin"}'
```

This mints the `kasra-digid` identity (fork path; `kasra` is a reserved name, so the
tenant form is `kasra-<slug>`). The raw token is shown once — keep it for step 2 and
for the agent that will check in.

> Invariant (#44): the token MUST be `project=digid` scoped + agent-bound. NEVER an
> admin/null-scoped token — that would let the pot address any project.

## 2. Set it on the Digid pot + deploy

```bash
cd /home/mumega/mupot
npx wrangler secret put BUS_TOKEN --config wrangler.digid.toml   # paste the raw token
# BUS_URL defaults to https://bus.mumega.com — set only if your bridge differs:
# npx wrangler secret put BUS_URL --config wrangler.digid.toml
CLOUDFLARE_API_TOKEN=$(cat ~/.sos/keys/cf-token-mupot-digid-deploy.token) \
CLOUDFLARE_ACCOUNT_ID=e39eaf94f33092c4efd029d94ae1e9dd \
NODE_OPTIONS=--dns-result-order=ipv4first \
  npx wrangler deploy -c wrangler.digid.toml
```

`agents.digid.ca/fleet` now renders the live `project:digid` roster (the existing
`digid` agent appears with its liveness). Sends/control stay sealed (token is read-only).

## 3. Add an agent to the flock (e.g. kasra, dogfood)

Install the Claude Code pack (`packs/claude-code/flock-agent/`) on the agent, give it
the scoped token from step 1, and it checks in — appears `active` in `/fleet`, ages to
`dead`/absent when it stops. That on/off is the access inventory: who's in vs out.

For other runtimes (Codex, Hermes/Nous, Claude Cowork, openclaw) see the
[pack contract](flock-harness-pack-contract.md) — same lifecycle, harness-native config.
