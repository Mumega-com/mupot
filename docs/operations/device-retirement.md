# Retiring /device: operator runbook (maintenance half)

Status: **runbook only.** Nothing here has been run. Every step below needs a human-authorised
operator (Hadi's direct go for production, secrets or token revocation). The code half ships in
the PR "auth: retire /device (Option B task 0)" (mupot #2374, build brief PR #2376).

## What changed in code

`/device` and every path under it (`/device/code`, `/device/token`, `/device/preview`,
`/device/decision`, GET, unfurl, any method, any content type) now answers one constant
`410` JSON body (`device_flow_retired`, with `what_happened`, `who_acts`, `next_step`,
`help_url`). The handlers and the service (`device-routes.ts`, `device-grant.ts`) and
`scripts/device-grant-preview.mjs` are deleted. Nothing in the retired route reads KV, D1 or the
request body, so deploying the code **closes the door**: no new grant can be created, decided or
redeemed.

What deploy does **not** do: it does not remove data the old flow already wrote. That is this
runbook.

## What the old flow left behind

| Where | What | Sensitivity |
|---|---|---|
| `SESSIONS` KV `device-grant:<sha256(device_code)>` | grant record (`status` pending/approved/denied/consumed, `agent_id`, `token_id`) | metadata |
| `SESSIONS` KV `device-user:<tenant>:<NORMALIZEDCODE>` | user_code to grant hash | metadata |
| `SESSIONS` KV `device-pending:<tenant>` | list of pending grant hashes | metadata |
| `SESSIONS` KV `device-csrf:<nonce>` | one-time CSRF nonce | low |
| `SESSIONS` KV `device-redeem:<hash>` | **the raw agent key**, until redeemed or 10 min TTL | **secret** |
| D1 `member_tokens` | rows with `label = 'device:<USER_CODE>'`, `expires_at` = issue time + 3600s | hashed only |

KV values expire on their own (grant TTL 600s), but nothing may be assumed: an operator action
makes the disposition explicit and recorded.

## Rules for the operator

- Never print, log, paste or store a KV value under `device-redeem:`. Do not run `kv key get` on it.
  List key **names** only; delete by name without reading.
- Never put a token or secret in argv, chat or a receipt. Token ids are fine;
  raw keys are not. Read credentials from files.
- Take the smallest `fleet-unlock` window and relock (`fleet-lock`) right after.
- Record every step in a receipt (below). If any step cannot be completed, **stop**: leaving a
  bypass open is not an acceptable outcome (build brief task 0, rollback note).

## Order of operations

1. **Deploy the code first (separate authorised deploy "R0").** This stops new issuance. Read
   `/health`: `clean:true` and the retirement commit. Record the version id as the retirement floor.
   Live check, no secrets: `curl -si -X POST https://<pot>/device/code` returns `410`
   with `error: device_flow_retired`; `GET /device` returns `410` (no login redirect).
2. **Fix the clock reference.** Record `T_deploy` (UTC, from the deploy receipt) and measure clock
   uncertainty between the deploying host and Cloudflare (`date -u` vs the `Date` header of a
   response; take the larger observed skew, minimum 60 s). The **last possible old issuance** is
   the moment the last pre-retirement Worker version stopped serving: `T_last = T_deploy` plus the
   documented propagation window. If a gradual rollout or rollback happened, use the latest time the
   old version could have served.
3. **Inventory (read-only).** In D1, list legacy tokens without secrets:

   ```sql
   SELECT id, member_id, agent_id, tenant, label, created_at, expires_at, revoked_at, last_used_at
     FROM member_tokens
    WHERE label LIKE 'device:%'
    ORDER BY created_at;
   ```

   Never select `token_hash`. Save the result (ids, expiry, revoked state, last_used_at) to the
   receipt. Also list the audit side: `agent_token_issuance_audit` has no row for these tokens (the
   old flow wrote none), so the inventory above is the only complete record; note that gap.
4. **List KV key names (names only, no values).** For each prefix `device-grant:`, `device-user:`,
   `device-pending:`, `device-csrf:`, `device-redeem:` in the `SESSIONS` namespace, list key names and
   count them. Save counts and names (the names embed a hash or a user_code, no secret). Do not read values.
5. **Invalidate pending and approved handles.** Delete every `device-grant:*`, `device-user:*`,
   `device-pending:*` and `device-csrf:*` key by name. The retired route no longer reads them, but
   deleting removes any chance a future code revision treats them as live.
6. **Delete stored raw material.** Delete every `device-redeem:*` key by name, without reading it.
   This is the only place a raw key could exist at rest. Re-list afterwards: the count must be 0.
7. **Revoke uncertain ids.** For each `device:%` row from step 3 that is still unrevoked and either
   (a) was approved but never shown as used (`last_used_at IS NULL`), or (b) whose collection is
   uncertain, revoke it through the supported revocation path (the same mechanism used for any
   agent token revoke; do not hand-edit `revoked_at` in D1 unless that path is unavailable and the
   operator records why). Record each id and disposition (`revoked`, `expired_unused`,
   `in_use_kept_with_owner_ok`). A token in use by a real agent should be replaced by a normal
   connection and then revoked; ask the owner before cutting it.
8. **Wait.** Old tokens live for `3600 s` from issue. Do not declare completion until

   `now >= T_last + 3600 s + clock_uncertainty`

   Record `T_last`, the uncertainty used and the earliest completion time.
9. **Prove none live.** After the wait, run the inventory query again plus:

   ```sql
   SELECT count(*) AS live_device_tokens
     FROM member_tokens
    WHERE label LIKE 'device:%'
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > datetime('now'));
   ```

   Expected `0`. A row with `expires_at IS NULL` is not expected for this flow; if one exists treat it as live and revoke it. Re-list the five KV prefixes: expected 0 keys. Confirm the retired
   endpoints still answer 410.
10. **Retain receipts.** Store the inventory, key-name counts, per-id dispositions, `T_deploy`,
    `T_last`, uncertainty, the proof query output and the `/health` version in the Mumega receipts
    folder (`agents/kasra/receipts/`). Never include a KV value or any token material.

## Rollback

Do not restore the old mint endpoints. If the deploy has a problem, forward-fix the retirement
guidance or deploy a reviewed artifact that still has `/device` closed. A one-click dashboard
rollback to a pre-retirement Worker version reopens the old door; rollback targets must be the
retirement floor or later.

## Not covered here

Option B's own revocation and collection runbook (task 6). This document ends when step 9 proves
that no `device:` issuance is live.
