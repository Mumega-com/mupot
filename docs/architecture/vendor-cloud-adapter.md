# Vendor-cloud adapter (topology C) — pluggable completion port

**Status:** Implemented (BYOA slice 4). Branch-only; dyad-gate before merge.
**Contract:** [`runtime-adapter/v1`](../runtime-adapter-contract.md)
**Code:** `src/runtime/vendor-cloud/`

## What this is

Topology C: mupot launches work on a **vendor-hosted** cloud agent (the vendor's
own VPS/sandbox), the agent **attaches back** over signed HTTP
(`fleet-attach:v1`) to claim + report, and completion is observed through a
**pluggable completion port** — not a webhook-hardcoded path.

| Vendor | Launch | Completion |
|--------|--------|------------|
| Cursor Background / Cloud Agents | `POST https://api.cursor.com/v1/agents` | **Webhook** (HMAC `statusChange` → FINISHED/ERROR) **or** poll/SSE |
| Claude Managed Agents | agents → environments → sessions → events | **Poll/SSE only** (no webhook) |
| Codex Cloud | — | **Out of scope** (no public API; OpenAI issue #24777) |

## Live API version verification (2026-07-23)

Probed without credentials (expect **401**, not 404):

| Probe | Result |
|-------|--------|
| `POST api.cursor.com/v1/agents` | **401** — v1 exists |
| `POST api.cursor.com/v0/agents` | **401** — legacy still up |
| `GET api.cursor.com/v1/me` | **401** |
| `POST api.anthropic.com/v1/{agents,environments,sessions}` | **401** with `anthropic-beta: managed-agents-2026-04-01` |

Official Cursor docs pin the public-beta launch surface to **v1**. The adapter
hardcodes `CURSOR_AGENTS_API_VERSION = 'v1'` only after this live check
(`probeCursorApiVersions` / `api-version.ts`).

**Webhook caveat:** Cursor endpoints docs state webhooks are **"coming soon"**
on v1; the HMAC payload contract is documented and the legacy v0 launch body
accepts `webhook: { url, secret }`. The adapter:

1. Launches on **v1**.
2. Includes `webhook` on the create body when the webhook completion port is selected.
3. Always keeps **poll/SSE** available (required for CMA; Cursor fallback).

## Pluggable completion port

```text
CompletionPort = webhook | poll_sse
selectCompletionPort(vendor, webhookSecret, …)
  claude-managed  → always poll_sse
  cursor-background + secret → webhook
  cursor-background without secret → poll_sse
```

- **Webhook listener:** `POST /api/runtime/vendor-cloud/cursor/webhook`
  verifies `X-Webhook-Signature: sha256=<hex>` over the raw body
  (`CURSOR_WEBHOOK_SECRET`), parses `statusChange` FINISHED/ERROR, returns a
  land-at-`review` intent (never merge/deploy/self-verdict).
- **Poll/SSE listener:** `pollUntilComplete` + `parseSseDataLine` /
  `extractSseDataPayloads` for Cursor run stream and CMA session stream.

## Attach-back

`buildSignedAttachBackPlan` embeds `fleet-attach:v1` instructions into the
vendor prompt. Runtime types on attach: `cursor` (Background Agents) or
`claude-code` (CMA). Identity is server-derived; Ed25519 signed attach only —
no blanket bearer for topology C.

## Known risk — PR comment delivery (validated)

Cursor forum (staff-acked): API-spawned Background / Cloud Agents receive a
down-scoped GitHub installation token. They can clone + push commits, but
**cannot** post PR comments / reviews (`403 Resource not accessible by
integration`) even when the Cursor GitHub App has PR/issues write.

Sources:

- https://forum.cursor.com/t/background-agents-spawned-via-api-cannot-post-pr-comments-or-reviews-despite-correct-github-app-permissions/153207
- https://forum.cursor.com/t/cloud-agent-unable-to-edit-pr-description-or-add-comment/158985

**Adapter policy:** completion signal is webhook status / poll-SSE status +
branch ref — **not** a PR comment from the vendor agent. Prefer branch push;
`autoCreatePR` is optional. The pot gate (and driver) own PR commentary if
needed. Documented in the attach-back prompt fragment.

## Rails (non-negotiable)

- One contract (`runtime-adapter/v1`), no bespoke `*-worker.py` for this topology.
- Land at `status=review` behind `gate_owner`.
- Never merge / deploy / publish / self-verdict.
- Codex Cloud is not built.
