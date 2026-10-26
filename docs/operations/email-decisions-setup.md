# Email decisions: setup (PR1, log-only spike)

Design: `design-email-reply-approvals-20261026.md` (section 5). PR1 ships a log-only `email()` handler behind
`EMAIL_DECISIONS=1` (off by default). It writes no verdict, sends no mail and stores no body. It rejects every
inbound message with "Not accepting mail yet." The only purpose is to answer three questions before PR2/PR3:

1. Does Cloudflare put the DKIM/SPF/DMARC result in the headers the Worker sees?
2. Does the `+token` part survive in `message.to`?
3. What do Gmail and Outlook send?

Everything below is a Hadi action (DNS, secrets, dashboard). Nothing here has been done.

## Steps

1. **Domain.** Use the subdomain `decide.mumega.com`. Confirm `mumega.com` is on Cloudflare DNS and the
   subdomain has no existing MX/TXT records.
2. **Enable Email Routing** (dashboard: Email > Email Routing) and add the subdomain `decide.mumega.com`.
   Cloudflare adds `route1/2/3.mx.cloudflare.net` MX records and an SPF TXT record. This is a DNS change.
3. **Routing rule.** Custom address `approve@decide.mumega.com` -> action "Send to a Worker" -> the mupot Worker
   (it now exports `email()`). Plus-addressing: mail to `approve+<token>@decide.mumega.com` matches this one rule.
   Catch-all is apex-only, so do not rely on it.
4. **Sending onboarding** (needed from PR3, not for the spike): onboard `decide.mumega.com` in Email Service
   (adds SPF/DKIM TXT records). Email Sending is beta and needs Workers Paid for arbitrary recipients; confirm
   the plan.
5. **DMARC.** Add `_dmarc.decide.mumega.com` TXT `v=DMARC1; p=reject; rua=mailto:<your report address>` so our
   own mail is not a spoof target.
6. **Secret** (needed from PR2; PR1 does not read it): `npx wrangler secret put EMAIL_DECISION_HMAC_KEY`.
   Use 32+ random bytes. Never put it in argv, chat or wrangler.toml. Absent key = token mint/verify fail closed.
7. **Send binding** (needed from PR3): add to the gitignored `wrangler.toml`
   ```toml
   [[send_email]]
   name = "EMAIL"
   ```
8. **Migration.** Apply `migrations/0259_email_decision_foundation.sql` to prod D1 BEFORE deploying.
9. **Flag.** Set `EMAIL_DECISIONS = "1"` in `[vars]` only for the spike window, then remove it.

## Reading the spike receipts

After sending a test mail from Gmail and one from Outlook to `approve+test123@decide.mumega.com`:

```sql
SELECT received_at, envelope_from, envelope_to, raw_size, outcome, header_names, header_values
FROM email_inbound_receipts ORDER BY received_at DESC LIMIT 10;
```

Run it with `npx wrangler d1 execute <DB> --remote --command "..."`. Read:

- **Auth results reach the Worker** if `header_values` contains `authentication-results`, `arc-authentication-results`
  or `received-spf`, or any `cf-*` / `x-cf-*` header. If none appear, the in-Worker DKIM verification fallback (design
  section 3.2 step 4b) is required before PR3.
- **`+token` survives** if `envelope_to` still shows `approve+test123@...`.
- `header_names` is the full list of header names received (lowercased). `dkim-signature` values are reduced to
  `d=` and `s=`.

Limits: at most 200 receipts per rolling hour; mail over 64 KB is recorded as `spike_rejected_oversize`; header
values over 2 KB are replaced by `[redacted: N chars]`. The body is never read or stored.
