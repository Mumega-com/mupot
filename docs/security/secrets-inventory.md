# Secrets inventory — complete as of 2026-08-07

Every place a credential lives, across all five scopes. Companion to
[cloudflare-key-registry.md](cloudflare-key-registry.md) (which covers *what each
Cloudflare credential is for*); this document covers *where credentials exist at all*.

**Read [Scope 5](#scope-5--cf-user-owned-tokens--not-enumerable) first if you are auditing.**
One scope cannot be enumerated by any agent, and that is exactly where a live credential
was found hiding.

## Why this exists

On 2026-08-07, `~/.env.secrets` and `~/.hermes/.env` were found captured in plaintext
inside AI-CLI session transcripts (mupot#764). The remediation exposed a second problem:
**we did not have a complete list of where credentials live**, so "rotate everything"
had no definable end state. This document is that end state.

## The five scopes

| # | Scope | Count | Enumerable by an agent? |
|---|---|---|---|
| 1 | Host credential files | 68 | ✅ `find` |
| 2 | `~/.env.secrets` + `~/.hermes/.env` | 106 vars (75 credential-shaped) | ✅ read |
| 3 | Cloudflare Worker secrets (mupot) | 27 | ✅ `wrangler secret list` |
| 4 | GitHub Actions repo secrets | 4 (mumega-com) | ✅ `gh secret list` |
| 5 | **Cloudflare USER-owned API tokens** | **3 tokens + 1 Global API Key** | ❌ **dashboard only — closed by human read** |
| 6 | Cloudflare ACCOUNT-owned API tokens | 19 | ✅ API |

### Scope 1 — host credential files (68)

`~/.fleet/agents/` (34), `~/.sos/keys/` (28), `~/.fleet/` (3), `~/.hermes/` (3).
**All are mode 600** except `~/.hermes/hermes-agent/.env.example` and `.envrc` (660,
templates, no live values) and `~/.sos/keys/cf-tokens-LEDGER.md` (664 — a standing debt,
the ledger is group-readable).

Oldest live credentials: `cf-token-admin.token` and `posthog-full.token` (2026-05-30),
`kasra.key` / `river.key` / `codex.key` (2026-06-30).

### Scope 2 — the ambient env files

`~/.env.secrets`: **106 variables, 75 credential-shaped.** Loaded into ~50 systemd
`--user` services via `EnvironmentFile=`, most of which never touch most of those
credentials. This single file is the largest blast-radius object on the host and is the
one that leaked.

`~/.hermes/.env`: 18 secrets. Also leaked.

### Scope 3 — Worker secrets on the deployed mupot Worker (27)

```
BUS_TOKEN, CC_SPEND_SECRET, CONNECTOR_MASTER_KEY, DISCORD_BOT_TOKEN,
DISCORD_BOT_TOKEN_KASRA, DISCORD_BOT_TOKEN_MUMEGA, DISCORD_PUBLIC_KEY,
EVENT_INGEST_SECRET, FLEET_PANEL_SK, GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID,
GITHUB_APP_PRIVATE_KEY, GITHUB_PLAN_TIER, GITHUB_REPO, GITHUB_SYNC_PROJECT,
GITHUB_WEBHOOK_SECRET, GOOGLE_CHAT_PROJECT_NUMBER, GOOGLE_CHAT_SA_KEY,
GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, HERMES_RELAY_SECRET, IM_WEBHOOK_SECRET,
KAYHERMES_API_KEY, MUPOT_HANDOFF_PUBLIC_KEY, OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET,
POSTHOG_PERSONAL_API_KEY
```

⚠️ **`HERMES_WEBHOOK_SECRET` is NOT among them.** `src/telegram-bridge/bus_notify.ts:73-76`
fails closed without it — logs and returns `{delivered:false}` rather than sending
unsigned. **This is why the mubot Telegram notification feed does not deliver.** Caller is
`src/bus/consumer.ts:389`, which is wired, so the secret is the only missing piece.

⚠️ Note `HERMES_RELAY_SECRET` **does** exist. Confirm these are two different things
before setting a second one — a duplicated secret under two names is its own defect.

### Scope 4 — GitHub Actions repo secrets

`Mumega-com/mumega-com`: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`,
`SOS_BUS_TOKEN`, `SOS_BUS_URL`. `CLOUDFLARE_API_TOKEN` last updated **2026-05-03** —
predates the 2026-07-29 sweep and is a rotation candidate.

**CORRECTED 2026-08-07 by Dara's audit** ([credential-audit-2026-08-07.md](credential-audit-2026-08-07.md), #771).
I had this wrong twice over. `Mumega-com/mupot`'s workflows reference **no secrets at all**
— the `secrets.CLOUDFLARE_API_TOKEN` reference lives in **`Mumega-com/inkwell`**, not mupot.
And it is not a permissions gap: **zero org-level Actions secrets exist org-wide**, so that
workflow has nothing to resolve. Consequence: **"Deploy mumega.com" has been failing on
every run since 2026-05-10 — three months, silently.**

Also found, and absent from my sweep because I only looked at the repos I was working in:
`Mumega-com/therealmofpatterns` (public) carries its **own** `CLOUDFLARE_API_TOKEN` dated
2026-01-31 — six months stale, a stronger rotation candidate than the 2026-05-03 one above.
`Mumega-com/sos` and `Mumega-com/mirror` hold `HETZNER_HOST`, `HETZNER_SSH_KEY`,
`HETZNER_USER`, `DISCORD_DEPLOY_WEBHOOK` (2026-04-05).

⚠️ **Secret scanning is enabled on every PUBLIC repo and unavailable on all 15 PRIVATE
ones** (no GHAS tier). That is inverted from where the risk sits — `mumega-com` is private
and holds the Cloudflare and SOS Actions secrets directly. If a credential is ever
committed there, nothing automated catches it.

### Scope 5 — CF USER-owned tokens — CLOSED 2026-08-07 by dashboard read

**Enumerated by Dara via browser** at `https://dash.cloudflare.com/profile/api-tokens`
("User API Tokens", under My Profile — a *different page* from Account API Tokens).
CONFIRMED complete, not sampled: no pagination control present.

| token | permissions | resources | expires |
|---|---|---|---|
| `shabrang build token` | Account.Containers, Account.Secrets Store **+24 more** (26 total) | 1 Account, **All zones** | **never** | 🔴 INCIDENT — consumer: `Mumega-com/shabrang` Pages deploy; replacement token pending mint (task-f16dfac1) |
| `mumcp update` | Account.Workers R2 Storage | 1 Account | 2026-09-30 |
| `mumcp email` | Account.Email Sending, Zone.DNS | 1 Account, **All zones** | **never** |

Plus two non-token credentials on the same page:

- 🔴 **A legacy GLOBAL API KEY — active.** This is the highest-privilege credential on
  the account and it appears in *no* token listing. A Global API Key carries **complete,
  unscopable account control**, cannot be reduced to permission groups, cannot be
  resource-scoped, and **never expires**. It is strictly more powerful than the
  ~130-permission `kasra` token that prompted this whole policy. Any credential audit
  that enumerates tokens alone will never see it.
- A deprecated Origin CA Key.

`mumega R2 User Token` was deleted during this audit — it was the live production R2
access key (`58685be8…`), replaced by `r2-sos-rotate-20260807`.

**Why this scope needed a human.** `GET /user/tokens` returns
`403 Valid user-level authentication not found` for **every** token we hold, including
the ~130-permission admin token — because those are themselves *account-owned* and the
endpoint requires *user-level* auth. **No mintable token can close it.** It is a
structural boundary in Cloudflare's model, not a permissions gap.

It had already hidden a live credential: the production R2 access key matched **none** of
the 19 account-owned tokens. An audit that stopped at the account listing would have
declared itself complete while a live R2 key and a Global API Key sat unaccounted.

**Standing rule: a credential audit is not complete without a human reading
`My Profile → API Tokens` in the dashboard.**

### Scope 5 (historical) — why an agent cannot enumerate this

**This is the important one.**

`GET /user/tokens` returns `403 Valid user-level authentication not found` for **every
token we hold**, including the ~130-permission admin token — because those tokens are
themselves *account-owned*, and the endpoint requires *user-level* auth. An account-owned
token can never list user-owned tokens, regardless of its permissions.

**This is not a permissions gap that can be fixed by minting a better token.** It is a
structural boundary in Cloudflare's model.

**It already hid a live credential.** The R2 access key in production
(`R2_ACCESS_KEY_ID=58685be8…`) matched **none** of the 19 account-owned tokens. It is
user-owned or dashboard-created. Had we treated "enumerate the account tokens" as a
complete audit, we would have declared the inventory finished while a live, unaccounted
R2 credential remained.

**Therefore: any credential audit MUST include a human reading the dashboard.**
`My Profile → API Tokens` at <https://dash.cloudflare.com/profile/api-tokens>.
An agent cannot close this scope.

### Scope 6 — CF ACCOUNT-owned tokens (19)

16 pre-existing (13 never-expiring, 3 with `Account API Tokens Write` — i.e. able to mint
more tokens) plus 3 minted 2026-08-07 under the new policy:

| token | permissions | expiry |
|---|---|---|
| `hermes-ai-gateway-20260807` | AI Gateway Run/Read, Workers AI Read | 2026-11-05 |
| `hermes-web-research-20260807` | Browser Run Read/Write | 2026-11-05 |
| `r2-sos-rotate-20260807` | R2 Bucket Item Read/Write, Metadata Read | 2027-02-03 |

All three are IP-locked to **both** `5.161.216.149/32` and `2a01:4ff:f0:8693::/64`
(v4-only locks fail intermittently — see the registry's trap list).

## Remediation status

| item | status |
|---|---|
| Transcript redaction — `.codex/sessions` (214 files) | ✅ 0 exposed |
| Transcript redaction — `.hermes/sessions` (114) | ✅ 0 exposed |
| Transcript redaction — `agents/gemini` (251,586 files) | ✅ 2,223 redacted, 0 errors |
| Transcript redaction — `~/.claude/projects` | ✅ included in the same pass |
| R2 credentials rotated | ✅ tested before swap, consumer verified |
| Old R2 key revoked | ❌ **user-owned — dashboard only** |
| Stripe key rotated | ❌ Stripe console only |
| Capture mechanism fixed | ❌ **open — this is the one that matters** |

**The capture mechanism is still live.** Until it is fixed, any credential written to
`~/.env.secrets` or `~/.hermes/.env` will be captured into the next agent transcript.
Redaction removes yesterday's copies; it does not stop tomorrow's.

## Rules going forward

1. **One credential per named consumer.** Minimum permissions, resource-scoped, with an
   `expires_on`. Never account-wide when a bucket or zone will do.
2. **Never `.env.secrets`.** Each consumer gets its own `0600` file.
3. **Test before swap, revoke last.** `mint → test against the live service → swap →
   verify a real consumer → revoke`. A credential killed ahead of its consumer fails
   silently.
4. **An audit is not complete without the dashboard** (Scope 5).

## Verification tooling

- `~/.fleet/secret-verify.sh` — reports any in-scope secret value still present in any
  transcript root. Uses `grep -a`: a single NUL byte makes grep classify a file binary,
  skip it, and **still exit 0** — silence that reads as clean. `-a` defeats that.
- `~/.fleet/secret-scrub2.sh` — targeted redaction. Streams line-by-line; one 2 GB
  transcript exists, and any whole-file read OOM-kills the job.

Run both as `systemd-run --user` units. Shell backgrounding (`nohup … &`) does **not**
survive session teardown — three separate runs died that way and reported success.
