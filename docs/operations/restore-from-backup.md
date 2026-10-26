# Restore from the nightly D1 backup

The Worker takes an off-site backup of the mupot D1 database every night at 03:17 UTC and stores it in the R2 bucket bound as
`BACKUPS`. This page is steps only. Nothing here is run by the repo or by the Worker.

Code: `src/backup/nightly.ts` (logic), `BackupWorkflow` in `src/workflows/task-workflow.ts` (Workflow), migration `0259_backup_runs.sql`
(run record). Enabled by `NIGHTLY_BACKUP=1`; off by default.

## What is stored

| Key | Contents |
|---|---|
| `d1/mupot/YYYY-MM-DD.sql.gz` | gzip of the D1 SQL export (schema + data) |
| `d1/mupot/YYYY-MM-DD.manifest.json` | `sha256` and `size_bytes` of the `.sql.gz`, `raw_bytes`, `bookmark` (D1 Time Travel bookmark the dump is consistent with), `started_at`, `finished_at` |

Retention: the newest 30 daily dumps plus the newest 12 dumps taken on the 1st of a month. Older objects are deleted only after the
new dump is verified (size above 0 and the sha256 of the bytes now in R2 equals the manifest).

Every run writes a `backup_runs` row: `ok`, `failed`, or `skipped:no_credential`. A failure or a skip sends one Telegram alert through
the existing notification bot (`TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`). Check the last runs:

```bash
npx wrangler d1 execute <DB_NAME> --remote --command "SELECT run_date,status,r2_key,size_bytes,error,alerted FROM backup_runs ORDER BY run_date DESC LIMIT 10"
```

`backup_runs` lives in the database being backed up, so after a restore it shows the history as of the restore point. R2 is the source of truth.

## One-time setup (Hadi runs these)

1. Create the bucket:

   ```bash
   npx wrangler r2 bucket create mupot-backups
   ```

2. Create a dedicated API token (Cloudflare dashboard, My Profile, API Tokens, Create Custom Token). Do not reuse another token.
   - Permission: **Account, D1, Edit** (the `D1 Write` group). The D1 export endpoint changes database availability while it runs, and
     the API schema does not publish a separate export permission, so Edit is the least that is documented to work. `D1 Read` alone is
     not documented to be enough; if you want to try Read-only first, the first nightly run will record `failed` with the HTTP status and alert.
   - Account Resources: Include, the single mupot account. Cloudflare cannot scope the D1 permission to one database.
   - No zone permissions, no R2 permissions (the bucket is written through the Worker binding, not through this token).
   - Optional: client IP filtering is NOT usable (Workers egress addresses are not stable).
   - Set a TTL if you like, but an expired token makes the next run alert as `failed`; put a rotation reminder on it.

3. Put the secret (reads the value from stdin; never put it in argv or a file in the repo):

   ```bash
   npx wrangler secret put BACKUP_CF_API_TOKEN
   ```

4. In the live `wrangler.toml` (gitignored), set non-secret vars, uncomment the `BACKUPS` bucket binding, keep the `mupot-nightly-backup`
   Workflow block, and append the backup cron to the existing list (the first two entries unchanged):

   ```toml
   [vars]
   BACKUP_ACCOUNT_ID = "<cloudflare account id>"
   BACKUP_D1_ID = "<d1 database uuid>"
   NIGHTLY_BACKUP = "1"

   [triggers]
   crons = ["* * * * *", "0-9,15-24,30-39,45-54 * * * *", "17 3 * * *"]
   ```

5. Apply migration 0259 (before the deploy), then deploy as usual.

   ```bash
   npx wrangler d1 migrations apply <DB_NAME> --remote
   ```

6. Test once without waiting for 03:17: trigger the cron from the dashboard (Workers, mupot, Settings, Triggers, Cron Triggers) or
   start the `mupot-nightly-backup` Workflow with params `{"runDate":"YYYY-MM-DD"}`, then run the `backup_runs` query above.

Until step 3 is done, a run records `skipped:no_credential` and alerts. It never fails silently.

## Restore A: a dump into a fresh D1 database

Use this when the database is gone, corrupt, or you want to inspect an older day. It builds a new database; production is untouched until you
repoint the binding.

```bash
DATE=2026-10-25                      # the dump day
BUCKET=mupot-backups
WORK="$HOME/mupot-restore-$DATE"; mkdir -p "$WORK"

# 1. fetch the dump and its manifest
npx wrangler r2 object get "$BUCKET/d1/mupot/$DATE.sql.gz"        --remote --file "$WORK/dump.sql.gz"
npx wrangler r2 object get "$BUCKET/d1/mupot/$DATE.manifest.json" --remote --file "$WORK/manifest.json"

# 2. verify before trusting it: both lines must print the same sha256 and the same size
sha256sum "$WORK/dump.sql.gz"; python3 -c "import json;m=json.load(open('$WORK/manifest.json'));print(m['sha256'], m['size_bytes'])"
stat -c %s "$WORK/dump.sql.gz"

# 3. decompress
gunzip -k "$WORK/dump.sql.gz"        # produces $WORK/dump.sql

# 4. create a fresh database (pick the same location hint as production)
npx wrangler d1 create mupot-restored-$DATE

# 5. import (the dump carries CREATE TABLE and INSERT statements; foreign keys are handled by the export)
npx wrangler d1 execute mupot-restored-$DATE --remote --file "$WORK/dump.sql" --yes

# 6. sanity check
npx wrangler d1 execute mupot-restored-$DATE --remote --command "SELECT COUNT(*) AS tables FROM sqlite_master WHERE type='table'"
npx wrangler d1 execute mupot-restored-$DATE --remote --command "SELECT COUNT(*) AS members FROM members"
```

Then point the Worker at it: put the new `database_id` in the live `wrangler.toml` `[[d1_databases]]` block, deploy with `npm run deploy` (runs `scripts/deploy.mjs`: refuses a dirty tree and stamps `RELEASE_SHA`; never run `wrangler deploy` directly), and
check `/health`. A full `d1 execute --file` of a large dump can hit the per-statement size limit; if wrangler reports `Statement too long`,
see https://developers.cloudflare.com/d1/best-practices/import-export-data/ (troubleshooting).

Known export limit: D1 cannot export a database that has virtual tables (FTS5). mupot's migrations create none; if one is ever added the
nightly export will fail and alert.

## Restore B: Time Travel (in place, last 30 days)

Time Travel restores the SAME database to a minute within the last 30 days. It is destructive and overwrites in place, so record the
current bookmark first; that makes it reversible.

```bash
DB=<DB_NAME>

# 1. note where you are now (this is the undo point)
npx wrangler d1 time-travel info $DB

# 2. pick the target: either the bookmark stored in the manifest of the night you want ...
python3 -c "import json;print(json.load(open('manifest.json'))['bookmark'])"
#    ... or a timestamp (RFC3339 or unix seconds)
npx wrangler d1 time-travel info $DB --timestamp="2026-10-25T20:00:00+00:00"

# 3. restore (destructive)
npx wrangler d1 time-travel restore $DB --bookmark=<BOOKMARK>
#    or: npx wrangler d1 time-travel restore $DB --timestamp=<UNIX_TIMESTAMP>

# 4. undo, if it was the wrong point: restore the bookmark you noted in step 1
npx wrangler d1 time-travel restore $DB --bookmark=<BOOKMARK_FROM_STEP_1>
```

A bookmark older than 30 days is invalid. Past 30 days only Restore A (the R2 dump) works. That is the reason the off-site dumps exist.

## References

- D1 export API: https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/
- Import and export data: https://developers.cloudflare.com/d1/best-practices/import-export-data/
- Time Travel: https://developers.cloudflare.com/d1/reference/time-travel/
