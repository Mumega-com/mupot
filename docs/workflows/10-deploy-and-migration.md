# Deploy + migration (manual, snapshot, evidence)

Source: `docs/production-runbook.md` (full procedure) and `docs/operations/deploy-preflight.md`
(the gitignored-config gap CI cannot see). This is the platform/pot deploy — a human
operator pushing mupot core to a live Cloudflare Worker — not `project_deploy`
(`src/mcp/projects.ts:562`), which is a *tenant project's* code-deploy dispatched as a
flight (see `src/projects/deploy.ts`) and is a different workflow.

## Trigger

A human operator running commands from the runbook, never an MCP tool call. Two
paths, chosen by whether the pot is registered:

- Pot listed in `pots.manifest.json` → the update-guard path (`docs/production-runbook.md:164-181`).
- Pot not listed → the manual path (`docs/production-runbook.md:183-193`).

## Actor(s)

The pot operator (self-hosting) or, on the Mumega estate, Kasra-core only — never an
arm/subagent. Arms are barred from merge/deploy/publish by binding rule
(`agents/kasra/CLAUDE.md` § SECURITY APPROVAL PROTOCOL point 7); this runbook has no
code-level enforcement of that boundary, it is organizational.

## Tool/route sequence

Update-guard path (`docs/production-runbook.md:162-181`):
1. `git fetch origin` / `git status -sb` — confirm ref state.
2. `npm install`, `npm test`, `npm run typecheck` — local gates.
3. `node scripts/mupot-update.mjs "$POT"` — **dry run** (default, no `--apply`). Checks
   pending D1 migrations, destructive-migration patterns (`scripts/mupot-update.mjs:27`,
   regex at line 27), required bindings (`scripts/mupot-update.mjs:29`), source ref
   (`isMainDescendant`, imported from `scripts/lib/release-sha.mjs:1`), and health config —
   mutates nothing.
4. `node scripts/mupot-update.mjs "$POT" --apply` — only after reading the dry run.

Manual path (`docs/production-runbook.md:183-193`):
1. `git fetch origin` / `git status -sb`
2. `npm install`, `npm test`, `npm run typecheck`
3. `npx wrangler d1 migrations list "$DB" --remote --config "$CONFIG"`
4. `npx wrangler d1 migrations apply "$DB" --remote --config "$CONFIG"` — **migrations
   apply before code deploy**, always (`docs/production-runbook.md:195-197`).
5. `node scripts/deploy.mjs --config "$CONFIG" --message "..."` — wraps `wrangler deploy`;
   never call `wrangler deploy` directly for a real deploy (`scripts/deploy.mjs:1-24`).
   `scripts/deploy.mjs` refuses a dirty tree by default (`scripts/deploy.mjs:51-59`),
   derives `RELEASE_SHA` from `git rev-parse HEAD` only, and rejects any caller-supplied
   `--var RELEASE_SHA:...` (`assertNoCallerReleaseSha`, `scripts/lib/release-sha.mjs:54`).

Operator preflight, run before either path touches a real pot
(`docs/operations/deploy-preflight.md:59-65`):
```
grep -nE '^[ \t]*OAUTH_PROVIDER[ \t]*=' wrangler.<pot>.toml && echo 'STOP — rename to IDP_PROVIDER'
npx wrangler deploy --dry-run --outdir /tmp/preflight --config wrangler.<pot>.toml
```
then confirm in the printed binding table: `IDP_PROVIDER` present / `OAUTH_PROVIDER`
absent, `PUBLIC_ORIGIN` resolves, `RELEASE_SHA` supplied
(`docs/operations/deploy-preflight.md:67-75`).

Route read at the end of every deploy: `GET /health`, registered at `src/index.ts:93`
(`app.get('/health', (c) => c.json(publicHealth(c.env.TENANT_SLUG, c.env.RELEASE_SHA)))`).

## Human gate

The operator reading a dry-run before `--apply`/deploying is the gate — there is no
automated approval step. Two hard rules enforced in code, not just prose:
- `docs/production-runbook.md:286`: "Do not apply a migration to production until a D1
  backup exists for the current production state."
- `scripts/deploy.mjs:51-59`: refuses to deploy a dirty tree unless
  `MUPOT_ALLOW_DIRTY_DEPLOY=1` is explicitly set (and even then the stamp is marked
  `-dirty`, never "clean").

## Receipt(s) written

No D1 table — the receipt is the backup directory plus the on-worker health stamp.

Backup dir `$BACKUP_DIR` (`docs/production-runbook.md:290-311`):
| file | content |
|---|---|
| `git-sha.txt` | `git rev-parse HEAD` at backup time |
| `<pot>.toml` (copy of `$CONFIG`) | the exact deployed config |
| `pots.manifest.json` (copy, if present) | pot registry snapshot |
| `worker-secret-names.json` | `wrangler secret list` output — names only, no values |
| `d1.sql` | full `wrangler d1 export --remote` (schema + data) |
| `d1-schema.sql` | schema-only export (`--no-data`) |
| `r2/...` | copied/synced R2 objects |

On-worker stamp, read via `GET /health` (`src/health.ts:13-39`): `commit` (40-hex sha or
`<sha>-dirty`) and `clean` (boolean) — `clean` is only ever `true` for a bare 40-hex sha
that matches the baked `BUILD_INFO.commit`; a dirty tree or off-`main` HEAD always reports
`false`, never silently upgraded (`src/health.ts:22-28`).

## What the person sees

`GET /health` response shape: `{ commit: string | null, clean: boolean, ... }`
(`src/health.ts:38-39`). Operator also inspects, signed in as owner
(`docs/production-runbook.md:427-433`): `/ops` (schema, runtime liveness, webhook
checks), `/fleet` (runtime presence), `/members`, `/approvals`, `/loops`. The runbook's
own bar for "healthy" (`docs/production-runbook.md:433-434`): health endpoints pass, `/ops`
has no unexplained danger checks, an owner can log in, the runtime worker can attach or
check in.

## Tests that pin it

`tests/release-sha.test.ts`, `tests/health-version.test.ts`,
`tests/dashboard-deployment.test.ts`, `tests/fresh-install-receipt.test.ts`,
`tests/stable-deployment-receipt.test.ts`, `tests/release-readiness-receipt.test.ts`,
`tests/release-v030-contract.test.ts`, `tests/staging-recovery-rehearsal.test.ts`,
`tests/work-lifecycle-receipt.test.ts`, `tests/external-pr-cycle-receipt.test.ts`.

## Known gaps

- `docs/operations/deploy-preflight.md:1-10`: the real per-pot `wrangler.<pot>.toml`
  files are gitignored by design (they carry live account/database ids), so **no PR
  review and no CI test ever reads the file that actually configures a deploy** — this
  caused two production outages eight days apart (`#699`, then "P0-0") from the same
  defect surviving in the deploy config after the code fix had merged. `scripts/reserved-bindings.mjs`
  (CI job `reserved-bindings`) closes the *template* vector only
  (`docs/operations/deploy-preflight.md:46-53`); the gitignored per-pot configs remain
  outside every automated gate by design — mitigated procedurally by the preflight
  checklist above, not by a code gate.
- `tests/migration-numbering.test.mjs` / `scripts/check-migration-numbering.mjs` pin
  migration file numbering, but nothing in CI proves a given migration was actually
  applied to a specific production pot before its paired code deployed — that ordering
  is operator discipline (`docs/production-runbook.md:195-197`), not an enforced gate.
- `project_deploy` (`src/mcp/projects.ts:562`) is a distinct, code-driven workflow for
  tenant-project deploys via a dispatched flight (`src/projects/deploy.ts`) — it is not
  covered by this doc and has its own receipt table (`project_deployments`); a follow-up
  workflow doc for it is out of scope here.
