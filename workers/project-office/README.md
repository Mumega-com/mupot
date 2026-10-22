# mupot-project-office

The `ProjectOffice` Durable Object (one per project) on the Cloudflare Agents SDK, in **its own Worker**.
Phase 0 skeleton: inert, not deployed anywhere, off unless `PROJECT_OFFICE = "1"`.
Plan: `agents/kasra/docs/plan-project-back-office-20261022.md`.

## Why a separate Worker

Importing `agents` from the main mupot Worker raised non-idle startup CPU on every cold isolate for a feature that is
off (gate lens: ~62 ms -> ~255 ms median; `wrangler check startup` on this host: median 180 ms vs 93 ms, min 155 vs
70 ms, on a loaded machine). Here only the office pays it. The main Worker stays byte-identical to `main`
(`tests/office-worker-isolation.test.ts` pins that no `agents` dependency, import or export reaches it).

## Shape

- `src/project-office.ts`: `ProjectOffice` is a **facade**, a plain Durable Object whose public methods are exactly
  the office's own (`notice`, `prepare`, `dispatch`, `followUp`, `gate`, `remember`, `report`, `armFollowUpClock`,
  `rebuild`, `snapshot`). The SDK `Agent` is a private field built only after the project -> tenant check passes,
  so the SDK's RPC surface (`schedule`, `setState`, `sql`, `destroy`, `_cf_*`) is unreachable and a foreign-tenant
  object creates no tables at all.
- The SDK's client surface is shut: no identity/state/MCP frames, read-only, no sockets, no `/sub/` routing.
- Pure logic (flag, naming, `verifyOfficeBinding`, working-set schema, `rebuildWorkingSet`) is SDK-free in
  `../../src/projects/office-core.ts`; the contract is `office-contract.ts`, the main-side handle `office-handle.ts`.

## Commands (own `package.json` and lockfile; run here)

```
npm ci
npm run typecheck
npm test                                    # workerd, --maxWorkers=2
npx wrangler deploy --dry-run --config wrangler.example.toml
```

## Enabling (Phase 1, not before)

1. deploy this Worker (`wrangler.example.toml` -> `wrangler.toml`, own migration history starting at `v1`);
2. in the main Worker's config uncomment the `PROJECT_OFFICE_DO` binding with `script_name = "mupot-project-office"`
   and set `PROJECT_OFFICE = "1"` (the flag is read in both Workers);
3. deploy the main Worker.
