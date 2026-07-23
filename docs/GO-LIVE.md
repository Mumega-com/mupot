# Go live — the first gated outreach send (the v1.0 outcome)

Everything is built and deployed. This is the exact operator runbook to cross the last
gate: a real outreach send, approved by you, with a real reply moving the KPI. When this
runs clean, the version is **v1.0.0**.

## Runtime starter gate

Before business traffic, complete [the cross-platform runtime starter](runtime-starter.md)
for every local agent. The Mac launchd or Linux systemd service receipt, bounded
continuous receipt, governed start/stop evidence, starter receipt, and independently
checked copied bundle must all report `pass`. This gate supports co-resident and
distributed hosts and preserves configs, keys, and receipts during rollback. Do not
place bearer tokens or private keys in service environments or evidence files.

Run against the pot you operate (examples use the Digid pot; swap the config/URL).

## 1. Set the GHL secrets (one time)

```bash
npx wrangler secret put GHL_API_KEY        --config wrangler.digid.toml
npx wrangler secret put GHL_LOCATION_ID    --config wrangler.digid.toml
npx wrangler secret put GHL_WEBHOOK_SECRET --config wrangler.digid.toml
```

Point your GHL location's outbound webhook at:
`https://<your-pot>/api/integrations/ghl/inbound` (it's HMAC-verified by the secret above).

Until these are set the send path is inert (acts stay pending) — fail-closed by design.

## 1b. Secret env taker — CF ops bootstrap (one time)

Agents can request pot-level env bindings for MCP/API adapt; admins paste on **`/approvals`**.
Values land as Cloudflare Worker secrets on your account (D1 holds metadata only). Without
this bootstrap the bind path fails closed.

Binding contract and comments: **`wrangler.example.toml`** (`wrangler.toml` is gitignored).

```bash
npx wrangler secret put SECRET_ENV_CF_API_TOKEN --config wrangler.digid.toml
# vars (or secrets): SECRET_ENV_CF_ACCOUNT_ID, SECRET_ENV_CF_SCRIPT_NAME
# Token needs Workers Scripts:Edit (secrets) on the pot account
```

Set `SECRET_ENV_CF_ACCOUNT_ID` and `SECRET_ENV_CF_SCRIPT_NAME` in `[vars]` or as secrets.
Re-deploy after bootstrap so the Worker picks up vars.

v1 revoke of a Worker secret is done in the tenant CF dashboard / wrangler; reject does not
delete CF secrets.

## 2. Seed the outreach loop (through the product, not SQL)

Sign in as owner/admin, then:

```bash
curl -sX POST https://<your-pot>/api/loops/seed-outreach \
  -H 'origin: https://<your-pot>' -b cookies.txt
# → { ok, squad, loop }  — the Outreach squad + a GATED loop now exist
```

Watch it at **`/loops`** (status, KPI, budget) — it ticks every 15 min on the cron.

## 3. Import real prospects (published B2B contacts only)

```bash
curl -sX POST https://<your-pot>/api/prospects/import \
  -H 'content-type: application/json' -H 'origin: https://<your-pot>' -b cookies.txt \
  -d '{"prospects":[
        {"email":"name@company.com","org":"Company","contact_name":"Name",
         "source":"seed","consent_basis":"existing_relationship"}
      ]}'
# → { ok, queued, duplicate, invalid }
```

Set `consent_basis` honestly — `existing_relationship` or `consent` for contacts you may
lawfully email under CASL; `unknown` is allowed but every send is gated regardless.

## 4. Approve the first send

Within ~15 minutes the loop drafts to a queued prospect and a gated task appears in
**`/approvals`**. Review the draft, then **Approve**. The pot fires the send through GHL
(`runApprovedActs`) — and only then.

## 5. The KPI moves = v1.0.0

When the prospect replies, the GHL inbound webhook maps them to `replied` and the loop's
KPI advances (watch the funnel on `/loops`). That is the live outcome.

```bash
git tag v1.0.0 && git push origin --tags
```

It's earned: a governed, MCP-native loop drove real outreach to a real reply, every send
human-approved, within budget, fully audited — on your own infra.
