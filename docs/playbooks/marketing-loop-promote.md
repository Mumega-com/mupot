# Promote marketing CRO loop (paused → active)

Addon `marketing-cro-monitor` declares loop template `website-opportunity-review`
with `approvalRequired: true`. On activate, mupot inserts the loop row as
**`paused`** so it exists but does not run until an org-admin promotes it.

## Steps (Mumega dogfood)

1. Confirm the installation is `active` and the loop exists:

   ```text
   loop_list { status: "paused" }
   ```

   Look for `agent_id` shaped like `addon:<installationId>` and OKR mentioning CRO.

2. Promote:

   ```text
   loop_set_status { loop_id: "<id>", status: "active" }
   ```

   HTTP twin: `POST /api/loops/:id/status` with `{ "status": "active" }` (session owner/admin).

3. Wait for the next loop/cron tick (≈15 min on production heartbeat).

4. Verify a recommendation (or dry cycle) appears for the marketing addon —
   content/channel kinds from the monitor should be able to flow once sources
   produce observations.

## Fences

- Org-admin only (`hasWorkspaceAdmin` / HTTP `requireRole('admin')`).
- `killed` / `done` are terminal — cannot promote back.
- Do **not** change addon `defaultState` to auto-active; keep human promote.

## Related

- `docs/architecture/ecc-as-agent-runtime.md`
- `packs/cursor/ecc-operator/README.md`
