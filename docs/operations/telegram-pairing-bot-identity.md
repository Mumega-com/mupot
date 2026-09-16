# Telegram pairing bot identity (operator)

Connect Telegram on `/account` must deep-link to the bot whose webhook is
`POST /im/webhook` (Mupot pairing / `/start` redemption). It must not use
the generic outbound notify token.

Observed production failure at release `f49d9238`: Connect derived the
username from `TELEGRAM_BOT_TOKEN`, which resolved to `Sos_mumega_bot`.
SOS is a legacy long-poll consumer, not the pairing webhook. `/start` there
does not redeem a Mupot invite.

## Operator-only config (do not paste secret values)

1. Identify the Telegram bot that already has `setWebhook` pointed at this
   pot's `POST /im/webhook` (authenticated by `IM_WEBHOOK_SECRET`).
2. `wrangler secret put TELEGRAM_PAIRING_BOT_TOKEN` — that bot's token only.
3. Leave `TELEGRAM_BOT_TOKEN` as the outbound/notify token if that is still
   SOS. Do not copy it into `TELEGRAM_PAIRING_BOT_TOKEN`.
4. Redeploy is a separately authorized action. This branch does not deploy.
5. After deploy, a live canary (separately authorized) must show: a fresh
   pairing code opens the pairing bot, `/start` writes a completed
   `telegram_webhook_receipts` row and binds the member, and a replay is
   refused.

If `TELEGRAM_PAIRING_BOT_TOKEN` is unset or getMe cannot prove a non-SOS
username, `/account` fails closed: no Connect button and no `t.me/` link.

Do not write pairing codes, tokens, or webhook secrets into tasks, commits,
or receipts.
