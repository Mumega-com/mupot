// mupot — the shared contract. EVERY component builds against this file.
// Changing a type here is a cross-cutting change: coordinate, don't fork.

import type {
  D1Database,
  VectorizeIndex,
  Queue,
  KVNamespace,
  R2Bucket,
  Ai,
  DurableObjectNamespace,
} from '@cloudflare/workers-types'

// ── Workflow binding type ──────────────────────────────────────────────────────
//
// @cloudflare/workers-types exports `Workflow` as a global abstract class (not
// as a named export from the module), so it cannot be used directly in an
// interface import.  We define a minimal local structural type that matches the
// subset of the Workflow<PARAMS> API this codebase uses.  This avoids importing
// 'cloudflare:workers' (unavailable in Vitest) into types.ts, and keeps the
// binding testable via a plain mock object in tests.
//
// The real binding (Workflow<TaskPipelineParams>) is structurally assignable to
// this interface — TypeScript will verify that in task-workflow.ts where it is
// consumed.
export interface WorkflowBinding<PARAMS = unknown> {
  /**
   * Create a new Workflow instance.  Returns a handle; we only need the id.
   * The full CF type also accepts `id?` and `retention?` in opts — we surface
   * only `params` because that is what the pipeline uses.
   */
  create(opts: { id?: string; params: PARAMS }): Promise<{ id: string }>
  /**
   * Get a handle to an existing instance by id, for sendEvent on resume.
   */
  get(id: string): Promise<{
    sendEvent(e: { type: string; payload: unknown }): Promise<void>
    status(): Promise<unknown>
  }>
}

// ── Cloudflare bindings (must match wrangler.toml) ──
export interface Env {
  /** New routine human-review asks: 24h..7d, default 24h; snapshotted per ask. */
  ROUTINE_REVIEW_WINDOW_MS?: string
  DB: D1Database
  // Owner-call storage pilot. Default off; no notification consumer exists in slice 1.
  OWNER_CALL?: string
  // Secret JSON key ring, newest first: [{version,key}]. Retain old versions for all supported retry history.
  OWNER_CALL_HMAC_KEYS?: string
  // Email reply approvals (design-email-reply-approvals-20261026). '1' enables the log-only spike handler; off otherwise.
  EMAIL_DECISIONS?: string
  // Secret (wrangler secret put). Absent => token mint/verify fail closed.
  EMAIL_DECISION_HMAC_KEY?: string
  VEC: VectorizeIndex
  BUS: Queue<BusEvent>
  SESSIONS: KVNamespace
  // OAuth 2.1 state (clients, grants, tokens) — separate lifecycle from sessions.
  // The @cloudflare/workers-oauth-provider library reads/writes this KV namespace.
  // Declared in [[kv_namespaces]] binding="OAUTH_KV" in wrangler.toml.
  OAUTH_KV: KVNamespace
  BLOBS: R2Bucket
  // Sovereign-pot worker bundles, keyed `${RELEASE_SHA}/worker.js` (mupot#1285). Written
  // by a future CI step at deploy time (not yet implemented — see
  // docs/workflows/tenant-provision.md "bundle source"); provisionSovereignPot checks
  // this FIRST and falls back to an explicit `worker_js_code` argument when it is absent
  // or the bucket has no object for the current RELEASE_SHA. Optional and separate from
  // BLOBS (a different retention/access shape — release artifacts, not tenant content) so
  // a colony that has not wired the CI step yet simply runs the fallback path, unchanged.
  POT_WORKER_BUNDLE_BUCKET?: R2Bucket
  AI: Ai
  AGENT: DurableObjectNamespace
  SQUAD: DurableObjectNamespace
  // Live roster push channel (ADR #473). Optional: declared in wrangler but inert
  // until REALTIME_PRESENCE=1. See src/registry/realtime.ts + PresenceChannelDO.
  PRESENCE_CHANNEL?: DurableObjectNamespace
  // Body-free seat-events channel: one hibernating WebSocket per fleet host (src/agents/seat-events.ts).
  // Optional binding; inert until REALTIME_SEAT_EVENTS=1.
  SEAT_EVENTS?: DurableObjectNamespace
  // One Durable Object per project (the "project back office"). The class lives in its OWN Worker
  // (workers/project-office/), reached from here by a binding with script_name. Optional; INERT unless
  // PROJECT_OFFICE=1 (default off). Named PROJECT_OFFICE_DO because the PROJECT_OFFICE key below is the flag.
  PROJECT_OFFICE_DO?: DurableObjectNamespace
  // Durable task pipeline (issue #7, migration 0012).  Optional: only present
  // when the [[workflows]] binding is declared in wrangler.toml.  Code that
  // calls the binding should guard `if (env.TASK_WORKFLOW)` or use the
  // startTaskPipeline helper which handles the absent-binding case gracefully.
  TASK_WORKFLOW?: WorkflowBinding<import('./workflows/pipeline').TaskPipelineParams>
  // Nightly off-site D1 backup (src/backup/nightly.ts). Inert unless NIGHTLY_BACKUP=1.
  // BACKUPS is a NEW R2 bucket (see docs/operations/restore-from-backup.md); BACKUP_CF_API_TOKEN is a
  // dedicated narrowly scoped secret; a missing one is recorded + alerted as skipped:no_credential.
  BACKUP_WORKFLOW?: WorkflowBinding<import('./backup/nightly').BackupParams>
  BACKUPS?: R2Bucket
  NIGHTLY_BACKUP?: string
  BACKUP_CF_API_TOKEN?: string
  BACKUP_ACCOUNT_ID?: string
  BACKUP_D1_ID?: string
  // vars
  TENANT_SLUG: string
  // The tenant slug that owns THIS deployment's Worker-level operator secrets/config (as
  // opposed to any per-tenant vault connector). Set once, in wrangler.toml [vars], to the
  // SAME value as TENANT_SLUG for the pot's own operator deployment (e.g. "mumega") and left
  // unset for any deployment where env-level operator creds must never be read on behalf of
  // a tenant. Absent ⇒ no env-credentials fallback runs anywhere (fail-closed). Currently
  // gates src/addons/marketing/adapters/posthog.ts's env-fallback path (#473 CONCERN-2) —
  // without this, a non-owner tenant with an internal_adapter posthog binding would read the
  // operator's own PostHog project and emit it under its own tenant's observations.
  OWNER_TENANT_SLUG?: string
  // mupot#1889: comma-separated TOKEN ids (member_tokens.id) allowed to carry task_verdict `human_origin`
  // (harness-attested human decisions, e.g. the KayHermes gateway's own workspace token). Empty/absent = refuse
  // every human_origin. Read only via src/im/origin-attestors.ts.
  HUMAN_ORIGIN_ATTESTOR_TOKEN_IDS?: string
  BRAND: string
  // Gate-stall watchdog (mupot#1705): minutes a task may sit in review with no verdict before the
  // gate wake is re-sent (default 30), and the max re-wakes per review episode (default 3).
  GATE_STALL_THRESHOLD_MINUTES?: string
  GATE_STALL_MAX_REWAKES?: string
  // Approval expiry sweep (src/gates/approval-expiry.ts): the cron is a DRY RUN (logs counts, writes
  // nothing) unless this is exactly '1'.
  APPROVAL_EXPIRY_ENFORCE?: string
  // Which IdP the human web-login door uses. NAMED `IDP_PROVIDER`, NOT `OAUTH_PROVIDER` —
  // @cloudflare/workers-oauth-provider RESERVES the binding name `OAUTH_PROVIDER` and
  // injects its own OAuthHelpersImpl instance there at runtime. Declaring that name as a
  // string here was a lie the type system could not catch, because the two places that
  // read it disagreed and one of them cast through `unknown`:
  //   src/auth/index.ts    read it as a string  -> got an object -> 500 on /auth/login
  //   src/mcp/oauth-authorize.ts  cast it to the helpers object  -> correct
  // wrangler.toml already carried the rename (`IDP_PROVIDER = "google"`, with the reason
  // in a comment); no code had followed it. See the note on OAUTH_PROVIDER below.
  // Typed `string`, NOT 'google' | 'telegram'. A [vars] entry is arbitrary operator-supplied
  // text; declaring it pre-narrowed asserts a validation that nothing performs, and reading
  // a binding as a type it does not have at runtime is precisely what produced this bug.
  // Callers narrow it themselves and must keep an unrecognised value refusable.
  IDP_PROVIDER?: string
  // NOT configuration. Injected by the OAuthProvider wrapper (src/index.ts) and typed as
  // unknown on purpose: anything that wants the helpers must cast deliberately and say so,
  // and nothing can accidentally read it as a settable string again.
  OAUTH_PROVIDER?: unknown
  // Immutable git commit for the deployed build, supplied by the release deploy.
  RELEASE_SHA?: string
  // The pot's canonical public origin (e.g. https://agents.digid.ca). When set, the
  // orient brief pins its MCP endpoint to THIS instead of echoing the request Host
  // header (which is client-influenceable and renders into a DIRECTIVE surface). #88.
  PUBLIC_ORIGIN?: string
  // Canonical Google Workspace / Shared Drive root for collaborative artifacts (Issue #1044).
  // When set (e.g. 'https://drive.google.com/drive/folders/...'), the orient basin-drop
  // automatically grounds agents in their squad / workspace drive root.
  GOOGLE_WORKSPACE_DRIVE_ROOT?: string
  // SSO handoff (#262): mumega is the verified-identity issuer; this pot is a relying
  // party that ACCEPTS a signed verified-email claim and mints its OWN session — while
  // keeping its own Google OAuth (additive). We hold ONLY the issuer's Ed25519 PUBLIC
  // key (a var, not a secret — public material). No shared secret = sovereignty.
  MUPOT_HANDOFF_PUBLIC_KEY?: string
  // The login-handoff audience THIS pot accepts. mumega mints the claim with
  // aud = the pot's dashboard_url hostname (#yp-aud-gap), so each pot must verify
  // against its OWN hostname. Unset ⇒ default HANDOFF_AUD ('mupot.mumega.com'),
  // correct only for mumega#0. Every other pot MUST set this to its host.
  MUPOT_HANDOFF_AUD?: string
  // The login-handoff issuer THIS pot trusts. Unset ⇒ default HANDOFF_ISS
  // ('https://mumega.com'). ONLY set this if you also run your own handoff-claim
  // MINTING side (a different issuer) with a matching public key — overriding
  // this without matching the minting side breaks handoff (every claim gets
  // rejected as wrong_iss; fails safe, never permissive).
  MUPOT_HANDOFF_ISS?: string
  // Sidebar "Switch pot →" cross-tenant picker link. Unset ⇒ mumega's own
  // console (byte-identical to pre-#de-mumega-ify behavior). A forked pot
  // MUST set this to its own picker/home, or unset it entirely if it has
  // none — otherwise its users get sent to mumega's site.
  CONSOLE_SWITCH_POT_URL?: string
  // Domain for an agent-authored commit's email local part (baked into the
  // CUSTOMER's git history via github-execute.ts). Unset ⇒ 'agents.mumega.com'.
  AGENT_COMMIT_EMAIL_DOMAIN?: string
  // Reseller-pot owner-walk link host suffix (src/reseller/provision.ts's
  // DEFAULT_POT_HOST_SUFFIX), passed as a planner opt — never read from client
  // request input. Unset ⇒ 'mupot.mumega.com'.
  DEFAULT_POT_HOST_SUFFIX?: string
  // @deprecated SOS PAYLOAD retirement in progress (see docs/sos-payload-retirement-plan.md).
  // fleet window: SOS bus bridge REST — COMPAT SHIM ONLY (ADR #473).
  // Active fleet routes use D1 agent_messages + presence + Queue; see
  // docs/architecture/sos-coordination-compat.md. Do not add new callers.
  // Status: Zero active calls. Retained for ops visibility only during migration window.
  // Deletion blocked on sos#193 (deploy path undefined).
  BUS_URL?: string
  // fleet scoping (Flock #43): which project label this pot's fleet addresses, and
  // which ops agent receives control requests via agent_messages. NO code default —
  // the resolvers fail closed (null → refuse). Each pot sets these explicitly in its
  // wrangler vars (company: sos/kasra labels; tenant: its own project + operator agent).
  FLEET_PROJECT?: string
  FLEET_OPS_AGENT?: string
  // Gated live roster WebSocket fan-out (ADR #473). Set to "1" to enable
  // GET /api/presence/live + publish-on-mutation. Off by default — query-time
  // presence remains sufficient for the coordination loop.
  REALTIME_PRESENCE?: string
  // Set to "1" to enable /api/fleet/events (ticket + WebSocket), the message.created → SeatEventsDO
  // fan-out, and the /api/inbox/stream fence for agents with a live seat-events grant.
  REALTIME_SEAT_EVENTS?: string
  /** Member-token inbox SSE push. Opt-in only; never enables OAuth or dashboards. */
  INBOX_STREAM_PUSH?: string
  // Set to "1" to let a ProjectOffice serve. Default off: with it off every office entry point
  // refuses and nothing in the request path or any cron routes to one.
  PROJECT_OFFICE?: string
  // #2170: set to exactly "1" to let the project circuit breaker auto-archive (kill) a project at an
  // elapsed cycle boundary with no recommit. Unset/anything else = never auto-archive.
  PROJECT_BREAKER_KILL?: string
  // Set to exactly "1" to let mupot WRITE to a linked external board (Linear status/comment) for a task transition that
  // has a mupot receipt. Default off. Also requires binding meta.writeback === true. Inbound import is unaffected.
  BOARD_WRITEBACK?: string
  // Linear webhook signing secret (wrangler secret). Unset = the Linear webhook route answers 503.
  LINEAR_WEBHOOK_SECRET?: string
  // secrets (present at runtime only)
  // GitHub App user-authorization credentials (shared "mupot" App). Required to complete the
  // GitHub connect flow; when unset the connect callback refuses (fail closed).
  GITHUB_APP_CLIENT_ID?: string
  GITHUB_APP_CLIENT_SECRET?: string
  OAUTH_CLIENT_ID?: string
  OAUTH_CLIENT_SECRET?: string
  // One-time self-hosted first-owner ceremony. Enabled only while dashboard OAuth
  // is entirely unconfigured; the D1 singleton claim permanently closes it after use.
  BOOTSTRAP_OWNER_TOKEN?: string
  // Local-only test login. Intended for `wrangler dev` smoke testing with a local D1/KV.
  // Never set this on a deployed pot; when unset, /auth/dev-login is disabled.
  LOCAL_TEST_AUTH?: string
  LOCAL_TEST_AUTH_EMAIL?: string
  // OAuth 2.1 Google IdP secrets — set via `wrangler secret put`, never in .toml.
  // Deploy prerequisites: npx wrangler secret put GOOGLE_CLIENT_ID
  //                       npx wrangler secret put GOOGLE_CLIENT_SECRET
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  // @deprecated SOS compat shim only (ADR #473) — unused by active fleet routes.
  // Status: Zero active calls. Retained for ops visibility only during migration window.
  // Deletion blocked on sos#193 (deploy path undefined).
  // See docs/sos-payload-retirement-plan.md for inventory and retirement plan.
  BUS_TOKEN?: string
  GITHUB_TOKEN?: string // outbound: tasks↔issues mirror (fine-grained PAT or App install token)
  GITHUB_REPO?: string // "owner/repo" the pot weaves to (e.g. "Digidinc/Digid")
  GITHUB_WEBHOOK_SECRET?: string // inbound: verifies GitHub webhook (x-hub-signature-256)
  GITHUB_INBOUND_SQUAD_ID?: string // optional: squad that GitHub work-units land on
  MIRROR_URL?: string // base URL for SOS/Mirror API (e.g. https://mirror.example.com)
  MIRROR_TOKEN?: string // bearer token for the Mirror API
  MIRROR_SECRET?: string // shared secret for Mirror 16D RRF memory sub-app
  SOS_SECRET?: string // shared secret for SOS event bus bridge sub-app
  SOS_TOKEN?: string // token for SOS event bus bridge
  TORIVERS_SECRET?: string // shared secret for ToRivers v2 deterministic automation sub-app
  AI_GATEWAY_TOKEN?: string
  // Telegram bridge: Mupot bus consumer notifies Hadi of task events
  // via HMAC-signed POST to Hermes webhook deliver_only route.
  // Telegram ingress lives at POST /channels/telegram/webhook and authenticates with
  // IM_WEBHOOK_SECRET (below). The former /api/integrations/telegram route and its
  // TELEGRAM_WEBHOOK_SECRET / TELEGRAM_ALLOWED_SENDERS / TELEGRAM_BOT_USERNAME keys are
  // GONE — /channels resolves the caller to a member (member_identities) and applies
  // their capabilities, which the allowlist could not do. Do not reintroduce them:
  // a second authorisation model on one surface means the weaker one sets the level.
  //
  // INCIDENT (mupot#1420, 2026-09-16): a LATER attempt to build the dashboard's
  // Connect Telegram deep link derived a bot @username live via getMe using
  // TELEGRAM_BOT_TOKEN below — but that token belongs to the NOTIFICATION
  // BRIDGE bot (src/telegram-bridge/bus_notify.ts's outbound Bot API leg),
  // never to the DECISION-CHANNEL bot a human actually talks to (the Hermes
  // gateway's own bot, e.g. @kayhermes_mubot — polling mode, no webhook; see
  // docs/operations/telegram-project-onboarding.md). mupot never holds that
  // bot's token, so its username CANNOT be derived here at all, from any
  // secret on this Env — the getMe call above was silently deriving the WRONG
  // bot's name and rendering a deep link to it. Fixed by making the decision
  // bot's @username an explicit, non-secret, display-only org setting instead
  // (org_settings.im_bot_username — SETTINGS_KEYS.imBotUsername in
  // src/dashboard/settings.ts, written by the wizard's IM step and by
  // src/dashboard/im-settings.ts post-setup, read only by
  // src/dashboard/account.ts's deep link). It carries no authority: nothing in
  // the bind/redeem/authz path reads it, same as this comment's own prior
  // rule for the Env keys above. Do not reintroduce a getMe-derived username
  // for this purpose — a bot's own Bot-API token can only ever authenticate
  // ITS OWN identity, never another bot's.
  // Telegram notification bridge — PRIMARY delivery path (direct to Bot API).
  // Set via: npx wrangler secret put TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID
  TELEGRAM_BOT_TOKEN?: string
  TELEGRAM_CHAT_ID?: string
  HERMES_WEBHOOK_SECRET?: string
  TELEGRAM_BRIDGE_URL?: string
  // Delivery target for the message.created push seam (mumega-com#970) — the bus
  // consumer's outbound leg, distinct from TELEGRAM_BRIDGE_URL (a different route,
  // different payload shape). Non-secret: a full URL, e.g.
  // https://hermes-kay.mumega.com/webhooks/mupot-events. Set in wrangler.toml [vars].
  // Signed with HERMES_WEBHOOK_SECRET (above) — same secret, two consumers of it.
  // Absent (either this or the secret) ⇒ delivery is skipped, not attempted; see
  // src/bus/hermes-delivery.ts for the not_configured contract.
  HERMES_EVENTS_WEBHOOK_URL?: string
  IM_WEBHOOK_SECRET?: string // shared secret for the IM webhook (Telegram secret_token)
  HERMES_RELAY_SECRET?: string // shared secret for the Hermes → mupot channel relay
  FLEET_PANEL_SK?: string      // Ed25519 PRIVATE OKP JWK — signs fleet control-requests. `wrangler secret put FLEET_PANEL_SK`. Absent ⇒ /api/fleet/control 503 (fail-closed).
  PROJECT_LINK_SIGNING_KEY?: string // Ed25519 PRIVATE OKP JWK for signed cross-pot receipts; never shared with a peer pot.
  FLEET_CONSUMER_AGENT?: string // the host consumer agent id that reads + executes control-requests (the daemon reads its inbox as this). Absent ⇒ 503.
  // execution meter caps (env override; meter.ts defaults apply when absent)
  EXEC_MAX_DISPATCH_DAY?: string // max execute-mode dispatches per agent per UTC day
  EXEC_MAX_TOKENS_DAY?: string   // max tokens an agent may spend per UTC day
  // GHL act-channel secrets (issue #8) — set via `wrangler secret put`, NEVER in .toml.
  // All optional: absent = not_configured (fails closed, no send path opens).
  // See wrangler.toml for the operator `wrangler secret put` command block.
  GHL_API_KEY?: string           // GoHighLevel location API key (outbound send)
  GHL_LOCATION_ID?: string       // GHL location id (scopes all API calls)
  GHL_WEBHOOK_SECRET?: string    // HMAC-SHA256 secret for inbound webhook verification
  BILLING_PLAN_SECRET?: string   // HMAC-SHA256 secret: central billing source → POST /api/billing/plan (writes plan_tier)
  CC_SPEND_SECRET?: string       // HMAC-SHA256 secret: server transcript rollup → POST /api/economy/cc-spend (writes cc_spend_daily). Fail-closed: absent ⇒ 503.
  // Connector credential vault (issue #116) — AES-GCM-256 master key.
  // Deploy prerequisite: `npx wrangler secret put CONNECTOR_MASTER_KEY`
  // Value: 64-char hex string (32 bytes / 256-bit, e.g. `openssl rand -hex 32`).
  // Fail-closed: if absent, resolveConnector() returns null and addConnector() throws.
  CONNECTOR_MASTER_KEY?: string
  // Access approve page (docs/architecture/access-approve-page.md). Feature flag OFF unless
  // ACCESS_APPROVE_ENABLED is '1' or 'true': every /approve/* route answers 404 and the request tools
  // return no approve_url. All four below are required once enabled; any missing => fail closed 503.
  ACCESS_APPROVE_ENABLED?: string
  ACCESS_TEAM_DOMAIN?: string      // <team>.cloudflareaccess.com (scheme optional)
  ACCESS_AUD?: string              // the Access application's AUD tag (exact match)
  ACCESS_CANONICAL_HOST?: string   // DEDICATED approval hostname, distinct from the colony host: answers ONLY /approve/*
  ACCESS_MAX_JWT_AGE_SECONDS?: string // iat freshness window, default 60, max 300
  ACCESS_REQUIRED_AMR?: string     // optional comma list: the token's amr claim must contain one of these
  // Secure moments (docs/architecture/secure-moments.md). Feature flag OFF unless SECURE_MOMENTS is '1' or 'true':
  // /m/* answers 404 on every host and the request tools return no secure link.
  SECURE_MOMENTS?: string
  // Secure drops (W2, docs/architecture/secure-moments.md): sealed credential delivery to an agent host. OFF unless
  // SECURE_DROP is '1' or 'true' AND secure moments are themselves on; off is a true no-op (no route, no tool, no write).
  SECURE_DROP?: string
  SECURE_MOMENTS_HOST?: string     // DEDICATED hostname for /m/* and the WebAuthn RP ID; never a colony host, pot host, or ACCESS_CANONICAL_HOST
  // MCP URL-mode elicitation of secure-moment links (docs/architecture/secure-moments.md, W3). OFF unless '1' or 'true';
  // inert unless SECURE_MOMENTS is also usable and CONNECTOR_MASTER_KEY is set.
  MCP_URL_ELICITATION?: string
  // Telegram Mini App adapter for secure moments (W4). OFF unless TELEGRAM_MINIAPP is '1' or 'true' AND SECURE_MOMENTS is on.
  TELEGRAM_MINIAPP?: string
  TELEGRAM_MINIAPP_BOT_ID?: string            // numeric id of the DEDICATED bot (its token only the worker holds); part of the signed string
  TELEGRAM_MINIAPP_BOT_TOKEN?: string         // REQUIRED worker SECRET (wrangler secret put) of the DEDICATED Mini App bot: used ONLY to send the web_app button, never to validate initData
  TELEGRAM_MINIAPP_MAX_AGE_SECONDS?: string   // initData auth_date freshness, default 300, cap 3600
  TELEGRAM_MINIAPP_EXTRA_PUBKEYS?: string     // staging only: extra Ed25519 keys (64-hex, comma separated); production accepts Telegram's production key alone
  // W4.2 sub-flag: PIN fallback + user-chosen trusted-device window. OFF unless '1' or 'true' AND the Mini App channel is on; off = W4.1 behaviour.
  TELEGRAM_MINIAPP_PIN_WINDOW?: string
  // Approval bot ("/muapprove"; src/approval-bot/): a DEDICATED Telegram bot the worker owns. OFF unless APPROVAL_BOT_TOKEN is set.
  // APPROVAL_BOT_TOKEN and APPROVAL_BOT_WEBHOOK_SECRET are worker SECRETS (never in wrangler.toml); APPROVAL_BOT_USERNAME is its @username.
  APPROVAL_BOT_TOKEN?: string
  APPROVAL_BOT_WEBHOOK_SECRET?: string
  APPROVAL_BOT_USERNAME?: string
  // Owner sudo (src/auth/owner-sudo.ts): '1' or 'true' enables requesting and using the four action:sudo_* actions. Default OFF.
  OWNER_SUDO_ENABLED?: string
  // Secret-env taker: CF Workers Secrets API bootstrap (fail-closed when incomplete).
  // Deploy setup: wrangler.example.toml (SECRET_ENV_CF_* block).
  // SECRET_ENV_CF_API_TOKEN MUST be set via `wrangler secret put` — never in [vars].
  // SECRET_ENV_CF_ACCOUNT_ID and SECRET_ENV_CF_SCRIPT_NAME may be [vars] or secrets.
  SECRET_ENV_CF_API_TOKEN?: string
  SECRET_ENV_CF_ACCOUNT_ID?: string
  SECRET_ENV_CF_SCRIPT_NAME?: string
  // Inkwell API origin the inkwell-content ACT executor POSTs to (S4 live-wire).
  // Non-secret; set in wrangler.toml [vars]. e.g. https://inkwell-api.mumega.com.
  // Must be https + a public host (executor SSRF-guards it). Absent ⇒ executor 503.
  INKWELL_API_URL?: string
  // Email one-time link/code sign-in — a normal-login door beside Google
  // (mupot#1564/#1442, Hadi 2026-09-26: "we only have Google login — a big
  // stone in front of onboarding"). Off unless EXACTLY "true", same posture
  // as POT_SELF_SERVE_CHECKOUT_ENABLED (src/pots/checkout-flag.ts) — read via
  // isEmailLoginEnabled() in src/auth/email-login.ts. Landing hides the email
  // option and /auth/email/* 404s when unset/false.
  EMAIL_LOGIN_ENABLED?: string
  // 'console' (dev/test — logs the link+code, never sends real mail) or unset
  // (Resend, the only real provider today). LOCAL_TEST_AUTH=1 also forces the
  // console sender regardless of this value. See src/auth/email-sender.ts.
  EMAIL_PROVIDER?: string
  // Same secret/var names as workers/inkwell-api's own request-code Resend
  // sender (src/routes/auth.ts) — one Resend key/from-address pair serves
  // both workers. Secret via `wrangler secret put RESEND_API_KEY`;
  // RESEND_FROM_EMAIL is non-secret (a from-address) and may live in [vars].
  // Missing either in prod: the /email/start route still 200s (no oracle),
  // logs one structured error, and never sends.
  RESEND_API_KEY?: string
  RESEND_FROM_EMAIL?: string
  // Optional service binding to the pot's Inkwell API worker. When the pot and its
  // Inkwell live on the SAME Cloudflare zone, a public-edge fetch to INKWELL_API_URL
  // loops back and times out (CF 522). This binding routes the content-write
  // subrequest internally (worker→worker), bypassing the public edge. Absent ⇒ the
  // executor falls back to a public-edge fetch (cross-zone tenants). Declared in
  // wrangler.toml [[services]]; INKWELL_API_URL still supplies the request path.
  INKWELL_SVC?: Fetcher
  // CRO data source — PostHog connector (CRO epic, slice 2). The first EXTERNAL source on
  // the data fabric. PROJECT_ID + HOST are non-secret (wrangler.toml [vars]); the personal
  // API key is a secret (`wrangler secret put POSTHOG_PERSONAL_API_KEY`). Fail-closed: the
  // PostHog source is `available()` only when KEY + PROJECT_ID are both present.
  POSTHOG_PROJECT_ID?: string // PostHog project id (e.g. "436189"). Non-secret.
  POSTHOG_HOST?: string // PostHog API host. Default https://us.posthog.com. Non-secret; https only.
  POSTHOG_PERSONAL_API_KEY?: string // PostHog personal API key (read-scope). Secret. Absent ⇒ source unavailable.
  // Cursor Cloud Agents API (src/cursor/client.ts). Secret via `wrangler secret put`.
  // CURSOR_API_TOKEN is the pot's preferred name; CURSOR_API_KEY is accepted as an
  // alias because that is the name Cursor's own docs use.
  CURSOR_API_TOKEN?: string
  CURSOR_API_KEY?: string
  // #1762: Studio cursor-cloud dispatch bounds (non-secret, integers; defaults 3 / 1 / 90). See src/dashboard/studio-limits.ts.
  // mupot#1794 W1: zero-touch harness seats. '1' enables harness upsert on the unbound OAuth
  // consent and the seat_select tool; anything else (including unset, the prod default) is a
  // total no-op. SEAT_MAX_PER_MEMBER caps live seats per human (default 16, clamped 1..256).
  SEAT_AUTO_ENROLL?: string
  // Strict '1' adds keyed hashes of short _meta values and allowlisted header values (plus header names) to the
  // sampled harness_identity_probe log line. Default off; raw values are never logged. With ONLY this flag on (seat enroll
  // off) the probe still covers every OAuth context that reaches resolveSeatSession, rate-limited to one line per grant per
  // hour per isolate. `_meta` values are hashed only for the allowlisted keys in PROBE_META_HASH_ALLOW; other keys by name only.
  HARNESS_PROBE_VERBOSE?: string
  // Secret (>= 24 chars). When set, a request presenting it in `x-server-timing-key` gets a Server-Timing header (phase names + ms only).
  // Operator-gated by design; never replace with a plain flag (diagnostics would reopen the existence oracle). Unset = disabled.
  SERVER_TIMING_KEY?: string
  // Workspaces W1: strict '1' turns on worktree_open / worktree_list and grant-keyed OAuth harnesses.
  // Anything else (including unset, the default) is a total no-op: no tool advertised, no read, no write.
  WORKSPACES?: string
  // W2 (harness seats -> existing agents): strict '1' (AND SEAT_AUTO_ENROLL '1') turns on seat_attach, the
  // dashboard Connections attach/admit actions and the per-request attachment resolve. Unset = total no-op.
  SEAT_ATTACH?: string
  // SEAT_ATTACH_DESIGNATED: strict '1' (requires SEAT_ATTACH) narrows attach to agents an org admin designated for the human
  // (agents.attach_designated_member_id, 0238). Unset = today's behaviour exactly.
  SEAT_ATTACH_DESIGNATED?: string
  // Admission by observation P0 (SHADOW ONLY): strict '1' taps every seat tool call into the seat_tape (shape-only, waitUntil)
  // and adds whoami.admission for a seat with a status. Never blocks or changes a status. Unset = total no-op.
  ADMISSION_TAPE?: string
  // #2035 wall 1 (VIP lane): strict '1' turns on join_squad (an owner/org-admin's seat joins a squad instantly as OBSERVED) and enforces the
  // observed floor on every call of a seat whose agent_seats.admission_status is observed/held. Unset = tool absent, no floor read, total no-op.
  VIP_LANE?: string
  // #2025: a flight landing requires evidence (result submission from the flight agent + independent verdict). Default ON;
  // set to exactly "0" to roll back. Anything else, including unset, keeps it required.
  LAND_REQUIRES_EVIDENCE?: string
  SEAT_MAX_PER_MEMBER?: string
  // mupot#1794 W2: LIFETIME bound on agent_seats rows per member, retired/inactive included
  // (migration 0199 trigger; default 64, clamped 1..4096). Atomic and fail-closed.
  SEAT_MAX_TOTAL_PER_MEMBER?: string
  // mupot#1794 W4 (migration 0202): LIFETIME bound on seats per HARNESS (default 32, clamped 1..4096).
  SEAT_MAX_TOTAL_PER_HARNESS?: string
  // mupot#1794 W4: shared-credential detection (default OFF; its own flag so flag-off adds no query,
  // write or response field for any existing credential). '1' records a throttled per-session
  // fingerprint per credential and surfaces `shared_credential` in boot_context when more than
  // SHARED_CREDENTIAL_MAX_SESSIONS (default 3) distinct fingerprints are seen in 15 minutes.
  SHARED_CREDENTIAL_DETECT?: string
  SHARED_CREDENTIAL_MAX_SESSIONS?: string
  STUDIO_DISPATCH_MEMBER_LIMIT?: string
  STUDIO_DISPATCH_REPO_LIMIT?: string
  STUDIO_DISPATCH_WINDOW_MINUTES?: string
  // Workers for Platforms dispatch namespace (optional). When bound, project
  // preview routes (`/preview/:project_id/*` and `https://<project>.mupot.mumega.com`)
  // proxy to the project's user Worker. Absent ⇒ fallback preview renderer.
  // Declared in wrangler.toml [[dispatch_namespaces]] binding="DISPATCHER".
  DISPATCHER?: import('./platform/dispatcher').DispatchNamespace
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
  // mupot#1518 hotfix: anonymous self-serve pot checkout (POST /api/pots/checkout and every
  // route that reaches it) is OFF unless this is exactly the string "true". Any other value,
  // or unset, returns 503 checkout_unavailable before any DB read or Stripe call, and
  // /pricing renders its plan buttons disabled. Read via isPotSelfServeCheckoutEnabled().
  POT_SELF_SERVE_CHECKOUT_ENABLED?: string
  // mupot#1618 MCP Events (protocol 2026-07-28): OFF unless exactly the string "true". Off =>
  // every request is byte-identical to before: 2026-07-28 is not negotiated and server/discover
  // and events/* are method_not_found. Served only on the full /mcp door, never on
  // /mcp/profile/needs-you, whatever the value. Read via isEventsEnabled() in src/mcp/events.ts.
  EVENTS_ENABLED?: string
  // mupot#1571/#1778: archiving TASKS is off unless exactly "1". Unset => archive_row/unarchive_row on
  // tasks return 409 not_supported, as before #1778. Must not be set until #1780 lands. Read via
  // taskArchiveEnabled() in src/hygiene/archive.ts.
  TASK_ARCHIVE_ENABLED?: string
  // Operators + Admission W0 (mumega-com#1386): delegated operators. OFF unless exactly "1" or "true". Off =>
  // an agent-bound caller gets exactly the pre-W0 lane on every structural write (the HTTP doors now match MCP).
  // On => a bound agent may ALSO act inside a live agent_operator_delegations row, through the single
  // chokepoint src/operators/chokepoint.ts. Read via delegatedOperatorsEnabled().
  DELEGATED_OPERATORS?: string
  // Installer window (PR-C, design S1): opt-in flag, default OFF. Read via installerWindowEnabled() in src/operators/installer-window.ts.
  INSTALLER_WINDOW?: string
  /** Opt-in ("1"/"true"): outbound Grok Bot webhook doorbell (src/agents/webhook-doorbell.ts). Default off. */
  WEBHOOK_DOORBELL?: string
  /**
   * Opt-in ("1"/"true"): new doorbell registrations are signed HMAC wakes on the events
   * queue (src/bus/doorbell-delivery.ts). Default off. Legacy rows keep the bearer POST
   * until the agent re-registers. Requires migration 0256 (`delivery_version`).
   */
  WEBHOOK_DOORBELL_SIGNED?: string
  // mupot#1618 PR 2: exact-hostname allowlist (comma list) of MCP Events webhook callback hosts.
  // Unset or empty (the default) refuses EVERY callback URL (`callback_host_not_allowed`), so
  // subscribing cannot reach any host until an operator names one. IP literals/wildcards ignored.
  EVENTS_CALLBACK_HOSTS?: string
  SUPABASE_WEBHOOK_SECRET?: string
  // TypeSafe Jev (System One) — used only by the agent_lifecycle intent path.
  // Absent ⇒ that path returns classifier_unavailable (no guess, no execute).
  // Explicit `action` never reads this. Secret via `wrangler secret put` if
  // a deployment wants the free-text path; this pilot does not deploy it.
  TYPESAFE_API_KEY?: string
  // Decision port (src/decisions). Absent/unknown DECISION_ADAPTER => 'human' (defer to a
  // human; no model call). DECISION_GATEWAY_ID optionally routes the Workers AI adapter
  // through a Cloudflare AI Gateway.
  DECISION_ADAPTER?: string
  DECISION_GATEWAY_ID?: string
}

// ── Org domain (mirrors migrations/0001_init.sql + 0009_work_unit.sql) ──

// Work-unit enums — shared by Agent and Squad (fractal: same shape at every level).
// effort: ceiling on spend / tool-calls when the unit is in execute mode.
export type Effort = 'low' | 'standard' | 'high' | 'sprint'
// autonomy: maps to gate level — execute_with_approval auto-sets gate_owner on tasks.
export type Autonomy = 'suggest' | 'draft' | 'execute' | 'execute_with_approval'
// budget_window: rolling window for budget_cap_cents accounting.
export type BudgetWindow = 'day' | 'week'

const EFFORTS: readonly Effort[] = ['low', 'standard', 'high', 'sprint']
const AUTONOMIES: readonly Autonomy[] = ['suggest', 'draft', 'execute', 'execute_with_approval']
const BUDGET_WINDOWS: readonly BudgetWindow[] = ['day', 'week']

export function isEffort(v: unknown): v is Effort {
  return typeof v === 'string' && (EFFORTS as readonly string[]).includes(v)
}

export function isAutonomy(v: unknown): v is Autonomy {
  return typeof v === 'string' && (AUTONOMIES as readonly string[]).includes(v)
}

export function isBudgetWindow(v: unknown): v is BudgetWindow {
  return typeof v === 'string' && (BUDGET_WINDOWS as readonly string[]).includes(v)
}

// OrgKind (migration 0093, mupot#925 P0-N1): 'work' (default, counted against
// PLAN_LIMITS) vs 'home' (bootstrap_self's per-human identity container —
// structurally exempt from every plan counter; see src/billing/plans.ts and
// src/org/service.ts). Declared here (not just in org/service.ts) so Department/
// Squad/Agent — read anywhere in the codebase — carry the real column.
export type OrgKind = 'work' | 'home'

export interface Department {
  id: string
  slug: string
  name: string
  kind: OrgKind
  created_at: string
}

export interface Squad {
  id: string
  department_id: string
  slug: string
  name: string
  charter: string | null // the squad's culture/mandate — tenant-authored
  kind: OrgKind
  // work-unit fields (0009_work_unit.sql)
  role: string | null           // accountability line for the squad
  okr: string | null
  kpi_target: string | null
  kpi_progress: number
  effort: Effort
  autonomy: Autonomy
  budget_cap_cents: number | null
  budget_window: BudgetWindow
  /** Pinned dyad review pair (migration 0246, src/gates/dyad.ts): both set or both null. Optional for legacy fixtures. */
  dyad_agent_a?: string | null
  dyad_agent_b?: string | null
  /**
   * Who created this row (migration 0166) — NULL for every row created
   * before this column existed. Provenance ground for team_bootstrap's
   * squad-adoption check (mupot#1498 P0(b) — replaces the old "empty squad"
   * emptiness ground entirely, since createSquad grants its creator no
   * capability row and every fresh squad satisfied that test). Stamped via
   * createSquad's opts parameter, never from a request body field (same
   * discipline as CreateOpts.kind).
   */
  created_by_member_id: string | null
  /**
   * elevation_grants.id that authorized this create, when created under a
   * bounded action:* elevation rather than standing capability (migration
   * 0166) — NULL otherwise (the common case) or for a pre-migration row.
   * No FK — see migration 0166's comment. Stamped via createSquad's opts
   * parameter, never from a request body field.
   */
  created_via_elevation_grant: string | null
  created_at: string
}

export interface Agent {
  id: string // also the DurableObject id name
  squad_id: string
  slug: string
  name: string
  role: string // tenant-defined role label
  model: string // e.g. "@cf/meta/llama-3.3" | "gemini-2.5-flash"
  status: 'active' | 'paused'
  kind: OrgKind
  // work-unit fields (0009_work_unit.sql)
  okr: string | null
  kpi_target: string | null
  kpi_progress: number
  effort: Effort
  autonomy: Autonomy
  budget_cap_cents: number | null
  budget_window: BudgetWindow
  created_at: string
  // profile fields (0068_agent_profile.sql) — Port 1.3. All nullable; pre-profile
  // agents read null. capabilities/skills are JSON-array strings on the wire,
  // parsed to string[] on read; death_condition is a JSON-object string.
  purpose: string | null
  owner: string | null
  model_fallback: string | null
  capabilities: string[] | null
  skills: string[] | null
  parent_agent_id: string | null
  qnft_ref: string | null
  death_condition: string | null
  // owner_member_id (0155_agent_owner_member_and_origin_verdict.sql) — the
  // member mupot says owns this agent's harness, for the sole purpose of
  // carrying that member's decisions through a harness-attested human_origin
  // (src/im/origin-verdict.ts). Deliberately distinct from `owner` (a free-text
  // display label) and from agent_keys (memberOwnsAssigneeAgent's conflict-of-
  // interest table) — do not conflate the three.
  owner_member_id: string | null
  // attach_designated_member_id (0238): the human whose chats may become this agent via seat_attach (SEAT_ATTACH_DESIGNATED).
  attach_designated_member_id?: string | null
}

export interface Membership {
  id: string
  agent_id: string
  squad_id: string
  capability: Capability // RBAC: what this agent may do in this squad
}

export type Capability = 'owner' | 'admin' | 'lead' | 'member' | 'observer'

export type TaskPriority = 'P0' | 'P1' | 'P2' | 'P3'
export const TASK_PRIORITIES: readonly TaskPriority[] = ['P0', 'P1', 'P2', 'P3']

export function isTaskPriority(v: unknown): v is TaskPriority {
  return typeof v === 'string' && (TASK_PRIORITIES as readonly string[]).includes(v)
}

export interface Task {
  id: string
  squad_id: string
  project_id: string | null
  /**
   * Rank. NULL means UNTRIAGED and is a real, visible state — see migrations/0079.
   * Before this existed, priority was encoded into task TITLES ("[P0] ..."), which is
   * unsortable, unfilterable, and invisible to every view. Untriaged rows sort LAST in
   * the ranker: deliberately, so that leaving work unranked has a cost.
   */
  priority: TaskPriority | null
  /**
   * Subtask link. NULL for a top-level task. ON DELETE SET NULL, never CASCADE —
   * an orphaned child surfacing as a top-level task is recoverable; a silently
   * deleted one is not (#705's lesson: a row can own more than itself).
   */
  parent_task_id: string | null
  title: string
  body: string
  status: 'open' | 'in_progress' | 'blocked' | 'done' | 'review' | 'approved' | 'rejected'
  assignee_agent_id: string | null
  /**
   * HUMAN owner (migrations/0150). Mutually exclusive with assignee_agent_id — a
   * DB trigger aborts any write that sets both, because two owners means every
   * reader picks one and different readers pick differently.
   *
   * This exists because the operator could not be given work on the board he was
   * looking at: anything needing a person (a browser click, a credential
   * decision, an approval) had to hide in prose inside some agent's task body,
   * where no query finds it and no lane surfaces it. It is a `members` reference,
   * NOT an agents row for the human — see the migration for why that shortcut is
   * the N-homes disease (squad-core 2c6273a6) rather than a fix for it.
   */
  assignee_member_id: string | null
  github_issue_url: string | null // tasks are mirrored to GitHub (source of truth)
  result: string | null // execution output (model answer) or a short failure note
  completed_at: string | null // ISO; set when execution finishes (done OR blocked)
  gate_owner: string | null // capability string gating the review→approved|rejected transition
  // Durable, human-readable outcome of the most recent automatic gate wake.
  // This is surfaced by task, board, and list reads; it is not execution output
  // and never authorizes a verdict.
  gate_wake_notice?: string | null
  // #142 capsule keystone: a checkable success predicate (e.g. "test X passes",
  // "GET /url returns 200", "migration applied"). Required on creation; the DB
  // column carries a sentinel default for rows pre-dating this migration.
  done_when: string
  // Durable pipeline (issue #7): set when this task was started via
  // POST /api/tasks/:id/pipeline.  Null on the legacy direct-execute path.
  // Used by the verdict endpoint to best-effort resume the waiting instance.
  workflow_instance_id?: string | null
  // At-most-once execution ownership. Dispatch receipts are retained after a
  // terminal write for Queue recovery; the lease is cleared on completion.
  execution_receipt_id?: string | null
  execution_claim_expires_at?: number | null
  // #403 gap 2(b): provenance marker. NULL for every locally-created task (the trusted path).
  // Set to the linked pot's slug (project_links.remote_pot) when this row was written by
  // receiveProjectLinkEnvelope (src/addons/project-link/service.ts) — a signal to any reader
  // (agent, dashboard, MCP client) that title/body originated from an external pot and should
  // be treated as untrusted content, not as a trusted local instruction. See migrations/0063.
  source_pot?: string | null
  // PR #659 P0 fix: same trust invariant as source_pot (NULL = trusted local write),
  // generalized for non-pot external integrations. Set to an opaque, integration-defined
  // string (e.g. `linear:<teamKey>`) when the row was written by a governed external
  // importer (src/integrations/linear-issues.ts) rather than a local/trusted caller. See
  // migrations/0077. Checked everywhere source_pot is checked (canAgentExecuteTask,
  // routeUnassignedWork, the admin-gated reassignment guard, the untrusted-content prompt
  // fence) -- kept as a separate column rather than folded into source_pot because it is
  // a different untrusted-writer class (no pot-to-pot signature involved).
  external_source?: string | null
  created_at: string
  updated_at: string
}

// ── Projects (migration 0055) ───────────────────────────────────────────────

export type ProjectStatus = 'planned' | 'active' | 'paused' | 'review' | 'completed' | 'archived'
export type ProjectAccessLevel = 'read' | 'write' | 'admin'
export type ProjectDeployStatus = 'idle' | 'queued' | 'deploying' | 'healthy' | 'failed'

export interface Project {
  id: string
  slug: string
  name: string
  description: string
  goal: string
  status: ProjectStatus
  parent_project_id: string | null
  target_date: string | null
  /** Next ISO-8601 instant at which the lifecycle circuit breaker evaluates (migration 0068). */
  cycle_boundary_at: string | null
  /** Stall detector flag (0/1); raised early into the breaker — detector is slice 4. */
  stalled: number
  /** Per-project idle threshold in days; NULL = tenant default. */
  stall_threshold_days: number | null
  /**
   * Principal that moved the project into completion review (migration 0069).
   * Used for different-principal self-verdict blocking (slice 2).
   */
  completion_proposed_by: string | null
  /** GitHub repository URL bound to this project's worker (migration 0129). */
  repo_url: string | null
  /** Cloudflare Worker script name for this project's live worker (migration 0129). */
  worker_name: string | null
  /** Public live URL for the project's worker (migration 0129). */
  live_url: string | null
  /** Squad that owns Cursor Cloud / deploy dispatch for this project (migration 0129). */
  assigned_squad_id: string | null
  /** Latest deploy pipeline status (migration 0129). Receipts live in project_deployments. */
  deploy_status: ProjectDeployStatus
  /**
   * Who created this row (migration 0166) — NULL for every row created
   * before this column existed. Provenance ground for team_bootstrap's
   * project-adoption check (mupot#1498 P0(a)): a caller may adopt a
   * pre-existing project by derived slug only if they made it themselves,
   * a prior team_bootstrap attempt already named it, or an org-admin
   * explicitly overrides (adopt:true) — never merely because the slug
   * matches. Stamped via createProject's opts parameter, never from a
   * request body field (same discipline as org/service.ts's CreateOpts.kind).
   */
  created_by_member_id: string | null
  /**
   * elevation_grants.id that authorized this create, when created under a
   * bounded action:* elevation rather than standing capability (migration
   * 0166) — NULL otherwise (the common case) or for a pre-migration row.
   * No FK — see migration 0166's comment. Stamped via createProject's opts
   * parameter, never from a request body field.
   */
  created_via_elevation_grant: string | null
  created_at: string
  updated_at: string
}

/** Immutable build receipt for one project deploy dispatch (migration 0129). */
export interface ProjectDeployment {
  id: string
  project_id: string
  commit_sha: string | null
  deployment_id: string
  url: string | null
  status: 'queued' | 'deploying' | 'healthy' | 'failed'
  dispatched_by: string | null
  flight_id: string | null
  created_at: string
}

export interface ProjectSquadAccess {
  project_id: string
  squad_id: string
  access_level: ProjectAccessLevel
  granted_at: string
}

// Append-only verdict receipt — written by POST /api/tasks/:id/verdict.
// No UPDATE or DELETE path exists (enforced in the route layer).
export interface TaskVerdict {
  id: string
  task_id: string
  verdict: 'approved' | 'rejected'
  note: string | null
  decided_by: string // agent id or member id of the principal
  decided_at: string // ISO-8601
  // decided_via / origin_agent_id (0155_agent_owner_member_and_origin_verdict.sql):
  // both NULL for every ordinary verdict. Set only when the verdict was cast
  // under a member's identity resolved from a harness-attested human_origin
  // (src/im/origin-verdict.ts) — decided_via = 'agent_attested_origin',
  // origin_agent_id = the CALLING agent whose harness vouched for the origin
  // (which may differ from decided_by, always a member id in that case).
  decided_via: 'agent_attested_origin' | null
  origin_agent_id: string | null
  // proposal_id / reversed_at (0159_task_verdict_proposal_binding.sql, FP-01
  // Slice 2 v2): proposal_id names the routine_run_actions.id this verdict
  // decided, resolved server-side at write time (never caller-supplied) —
  // NULL for every verdict not cast against a routine's human-review gate.
  // reversed_at is the ONE narrow exception to "append-only, no UPDATE
  // path": task_verdict_reverse stamps it on the verdict it reverses so a
  // proposal-bound reader (executeRoutineAction's grant check) can exclude
  // a reversed approval instead of treating it as still 'latest approved'.
  proposal_id: string | null
  // attachment_id / consenting_member_id (0247): set ONLY on a verdict cast through an ATTACHED agent session (decided_by = the
  // bound agent). The attachment and the human who attached it; NULL on every other verdict.
  attachment_id?: string | null
  consenting_member_id?: string | null
  // submission_id / result_digest (0252, seed-build-plan-20261022 B3): the task_result_submissions row (and its result_digest)
  // this verdict decided, bound ONLY when that row is the task's CURRENT submission (latest, text equals tasks.result, no
  // rejection after it). NULL otherwise, and on every pre-0252 verdict. A verdict bound to submission N does not count for N+1
  // (verdictForSubmission).
  submission_id?: string | null
  result_digest?: string | null
  // receipt_actor_kind (0252, seed B4): non-null iff the task was in receipt-chain scope when the verdict was written = "a
  // gate.verdict receipt is owed". Doubles as the pending marker the reconcile sweep reads and the actor kind it replays with.
  receipt_actor_kind?: 'member' | 'agent' | null
  // independence_waiver (0262): which verdict-independence exemption admitted the decider; NULL = none was needed.
  independence_waiver?: 'admin_supervisory' | 'owner_override' | 'owner_self' | null
  reversed_at: string | null
}

// ── Auth (app-layer RBAC; AuthN delegated to the perimeter/OAuth) ──
export interface AuthContext {
  userId: string
  email: string | null
  role: 'owner' | 'admin' | 'member' // org-level role (coarse; capabilities are the fine grain)
  tenant: string // TENANT_SLUG — every request is scoped to it
  memberId?: string // set when the principal is a network member (MCP/IM), not just a web login
  channel?: ConnectionChannel // how this principal connected
  capabilities?: CapabilityGrant[] // fine-grained, per-scope; the real RBAC
  /**
   * What this member ACTUALLY holds, resolved but NOT active as ambient authority.
   *
   * Equal to `capabilities` on every channel except `directory`, where the B1 ceiling
   * zeroes ambient authority so an OAuth seat cannot silently act with an owner's grants.
   * Latent grants let an EXPLICIT, NAMED, read-only act — today only `connect
   * { agent_name }` — be authorized against the truth instead of against the zeroed view.
   *
   * INVARIANT: never use this to satisfy an ambient capability check. Doing so reinstates
   * the silent inheritance the ceiling exists to prevent. Any new reader must be an
   * operation the caller named explicitly and that writes nothing. (#712)
   */
  latentCapabilities?: CapabilityGrant[]
  boundAgentId?: string | null // the agent this token is bound to (the weld), or null = pure human/operator
  /**
   * mupot#903b: for a directory-channel session consent-bound to an agent, the
   * MEMBER ID of the HUMAN who consented — distinct from `memberId`, which for a
   * bound session is the AGENT's own dedicated member (required by migration
   * 0071's member_tokens_agent_binding_insert trigger; see oauth-authorize.ts).
   * null for every unbound/workspace/im/dashboard session — there is no separate
   * "consenting human" concept outside the directory-consent flow.
   *
   * This is the identity the P0-1/P0-2 guards key off: capabilities are clamped
   * to this human's OWN live rank per scope (never wider than what they hold),
   * and re-checked live every request (offboarding this human kills the session's
   * authority even though the AGENT stays untouched).
   */
  consentedByMemberId?: string | null
  /** Assigned background consent cannot fall back to legacy consent after assignment is cleared. */
  backgroundAgentHumanRequired?: boolean
  tokenId?: string | null // exact live member_tokens row used for this request; server-derived only
  /**
   * mupot#1794 W1: the harness (OAuth client install) this UNBOUND directory grant was consented
   * through. An identity POINTER only — carried from the encrypted OAuth props via the internal
   * auth header, so it is never trusted on its own: seat_select / boot_context re-read the
   * harnesses row (tenant + member + id) live before use. Absent on every other session.
   */
  harnessId?: string | null
  /** #2060: admission status of the LIVE seat whose agent is boundAgentId, read in the SAME query that authenticated the token (no second read to
   *  fail open). undefined = not populated (VIP_LANE off, or a hand-built context); null = not a seat agent / no status. */
  seatAgentStatus?: 'observed' | 'trusted' | 'held' | null
  /**
   * mupot#1794 W4: true when this session was authenticated by a HARNESS-TOKEN credential (a
   * member_tokens row with harness_kind set) and NO seat handle has been applied. Derived per request
   * from the authenticating token ROW itself (never from the internal header blob, never from a second
   * lookup); such a session has ZERO capabilities and ZERO latent capabilities, and invokeTool admits
   * only HARNESS_SESSION_ALLOWED_TOOLS for it (src/members/harness-credential.ts). A seat session built
   * by applySeatHandle never carries it.
   */
  harnessCredential?: boolean
  /**
   * mupot#1794 W2: set ONLY by applySeatHandle (src/members/seat-handle.ts) when a valid seat handle
   * turned the human's grant into the seat agent's context. Server-derived on every request;
   * resolveAuth deletes any such field arriving in the internal header blob.
   */
  seatBinding?: { seatId: string; label: string; harnessId: string; grantTokenId: string; humanMemberId: string; source: 'handle' | 'auto:openai_session' | 'auto:codex_thread'
    /** W2 (SEAT_ATTACH): set ONLY by buildSeatContext when this thread is attached to an existing agent. A seat acting
     *  as an attached agent holds NO gate authority unless the admission opted in (gate_authority = 1, migration 0247; see
     *  src/auth/attached-gate.ts and callerHoldsGateCapability). `agentId` is the attached
     *  agent; `seatAgentId` is the thread's own seat agent it would otherwise be. */
    attached?: { attachmentId: string; admissionId: string; agentId: string; seatAgentId: string; ceiling: 'member' | 'lead' | 'full' } }
  /** mupot#1794 W2: what the request presented (booleans only) — receipt input, never authority. */
  seatInputs?: { handleRejected: boolean; hints: { openai_session: boolean; openai_subject: boolean; codex_thread_id: boolean }; autoSeatRefused?: string; attachRefused?: string }
  webSessionIdHash?: string | null
  webSessionMemberId?: string
  /**
   * OWNER SUDO (src/auth/owner-sudo.ts): set ONLY by invokeTool, in memory, on the AuthContext it builds for the APPROVING human
   * when an agent's live action:sudo_* grant covers exactly the tool being called. `memberId` is then the approving human (the
   * authority); this names the agent that is actually executing. Server-derived on every call; resolveAuth deletes any such
   * field arriving in the internal header blob. Presence is never touched under such a context.
   */
  /** Set ONLY by the owner-sudo auth builder (owner-sudo.ts), next to `ownerSudo`, after buildAuth(verifiedRole:true): says `role` was proven by a
   *  provider-verified identity, so squad-membership may map it to an org grant. Never derived from `role` alone; resolveAuth deletes it. */
  ownerSudoVerifiedRole?: true
  ownerSudo?: { executorAgentId: string; executorMemberId: string | null; grantId: string; elevationRequestId: string; action: string; tool: string; squadId: string | null }
}

// ── Members & capabilities — humans are first-class network nodes ──
// One person = one Member. They may connect via several channels (their own
// workspace over MCP, IM/Telegram via Hermes, or the web dashboard) — all resolve
// to the same member_id + capabilities. "Having effect" = acting through any
// channel, gated by capability.
export interface Member {
  id: string
  email: string | null
  display_name: string
  telegram_chat_id: string | null // IM-only members reach mupot through Hermes
  status: 'active' | 'suspended'
  created_at: string
  /** mupot#1997: set when this member's login identity was moved to another member; archive is an admin's call. */
  superseded_by_member_id?: string | null
}

// 'directory' is the OAuth 2.1 door — a seat that connected via the /authorize
// flow (ChatGPT, Claude, directory listings). Kept distinct from 'dashboard' (web
// login) and 'workspace' (API key) so the operator roster and revocation-by-channel
// paths stay legible. Added in migration 0020_oauth_channel.sql.
export type ConnectionChannel = 'workspace' | 'im' | 'dashboard' | 'directory'

// A scoped, revocable token a member puts in their workspace .mcp.json (or that
// Hermes holds to act for IM members). Stored hashed, like the SOS bus model.
export interface MemberToken {
  id: string
  tenant: string
  member_id: string
  token_hash: string
  label: string // "laptop", "hermes-gateway", ...
  channel: ConnectionChannel
  created_at: string
  expires_at?: string | null
  last_used_at?: string | null
  revoked_at: string | null
}

export type CapabilityScopeType = 'org' | 'department' | 'squad'

// member × scope → capability. Enforced on every write path (humans AND agents).
export interface CapabilityGrant {
  member_id: string
  scope_type: CapabilityScopeType
  scope_id: string | null // null for org-wide
  capability: Capability
}

// ── Bus ──
export type BusEventType =
  | 'lead.new'
  | 'task.created'
  | 'task.updated'
  | 'task.completed' // execution succeeded (ungated) — result persisted on the task row
  | 'task.review'   // execution succeeded on a gated task — task now awaits verdict
  | 'task.blocked' // execution failed (model error/timeout) — short note persisted
  | 'task.verdict' // gate decision written — verdict + new task status in payload
  | 'flight.landed' // governed flight completed with task, budget, and identity checks
  | 'agent.wake'
  | 'fleet.control.requested' // signed host-control request queued for the fleet daemon
  | 'brain.directive.updated' // owner-pinned directive changed for the brain decision loop
  | 'squad.dispatch'
  | 'org.provisioned' // a department/squad/agent/token was created in-band (payload.kind)
  | 'project.mutated' // project lifecycle or project-to-squad access changed through MCP
  | 'message.created' // an agent_messages row LANDED (mumega-com#970) — the push seam that
                      // makes an inbox poll unnecessary. Emitted ONLY on a real insert
                      // (result.meta.changes > 0), so a capped, fenced, or idempotent-
                      // duplicate send produces no event. See MessageCreatedPayload.
  | 'member.auto_enrolled'
  // mupot#1618 PR 2: one MCP Events webhook delivery attempt (queue job produced ONLY by the
  // message.created consumer leg and by its own retries). Internal-only: createBus().emit, the sos
  // addon's /publish and /bridge and the /bus/emit allowlist all refuse it
  // (src/bus/internal-events.ts), and the consumer rebuilds every fact of the delivery from D1.
  | 'mcp.event.delivery'
  // Signed webhook doorbell attempt (src/bus/doorbell-delivery.ts). Internal-only, same rule as
  // mcp.event.delivery: the consumer rebuilds the wake from D1. Flag WEBHOOK_DOORBELL_SIGNED.
  | 'mcp.doorbell.delivery'
  | 'assignment.wake' // INTERNAL job (src/agents/assignment-wake.ts): deliver this agent's queued assignment doorbells
  | 'billing.subscription.created'
  | 'billing.subscription.deleted'
  | 'pot.self_serve_provisioned'
  // Emitted when a self-serve (Stripe) provisioning run created resources but did NOT
  // produce a usable pot. A distinct type on purpose: a subscriber that treats a partial
  // run as a delivered product is exactly the failure this separates out (mupot#1285).
  | 'pot.self_serve_provisioning_incomplete'
  | 'routine.run.started'
  | 'supabase.record.insert'
  | 'supabase.record.update'
  | 'supabase.record.delete'

/**
 * message.created payload (mumega-com#970).
 *
 * Carries exactly the correlation a downstream runtime needs to activate on a message
 * WITHOUT reading it back — the point of the seam is that no consumer has to poll the
 * inbox to discover the message exists.
 *
 * It deliberately carries NO message body. The event says "a message landed, here is its
 * identity and routing"; reading it still goes through the authorized inbox path, so the
 * event cannot become a side channel that leaks message content past the tenant/project
 * authorization the inbox enforces. A subscriber that could read bodies off the bus would
 * be a second, weaker copy of the authorization surface — the exact shape that produced
 * the dashboard authenticated-≠-authorized defect (FLIGHT-001).
 */
export interface MessageCreatedPayload {
  message_id: string
  seq: number
  to_agent: string
  target_seat?: string | null
  from_agent: string
  from_member: string
  kind: string
  /** Present when the sender supplied one — the ACK correlation key. */
  request_id?: string | null
  /** Present when this message answers another — threads a conversation. */
  in_reply_to?: string | null
  project_id?: string | null
  created_at: string
}

export interface BusEvent<T = unknown> {
  type: BusEventType
  tenant: string
  squad_id?: string
  agent_id?: string
  actor?: {
    kind: 'member' | 'agent' | 'sso' | 'external' | 'system' | 'stripe' | 'routine'
    id: string
  } // attribution — who caused this
  payload: T
  ts: string // ISO; set by the producer
}

// ── Wake Contract ────────────────────────────────────────────────────────────
//
// Returned by mint_agent_token alongside mcp_endpoint. Describes exactly HOW
// to fire an agent.wake event at this agent via the mupot bus HTTP surface —
// the method, URL, required headers, and the body shape to POST.
//
// This is the self-serve equivalent of manual tmux send-keys: any caller that
// holds the operator token + this contract can wake the agent without hand-wiring
// or shell access. The bus consumer already routes agent.wake → AgentDO.wake();
// this type makes the wire format explicit and machine-readable.
//
// Cross-project note: today the /bus/emit endpoint is tenant-scoped —
// only tokens minted inside the same pot can emit. Cross-project wake uses
// project-link / multiplex on the mupot CF-native bus (not the retired SOS Redis bus).
export interface WakeContract {
  // POST this URL to fire the wake event.
  emit_url: string
  // Required header: 'Authorization: Bearer <OPERATOR_TOKEN>'
  auth_header: 'Authorization'
  // The body shape to POST (JSON). agent_id and tenant are pre-filled; reason
  // is caller-supplied context (short string, optional but recommended).
  body_shape: {
    type: 'agent.wake'
    agent_id: string
    tenant: string
    squad_id: string
    // context / reason the caller fills in at call time
    payload: { reason: string; context?: string }
  }
  // Human-readable note about the wake mechanism.
  note: string
}

// ── Ports (the swappable seams; CF profile implements these) ──
export interface MemoryPort {
  /** returns engram id. With `opts.waitUntil` the embedding + vector upsert run AFTER the D1 row commits,
   *  off the response path; a failure there is swallowed (the D1 row stays the source of truth and
   *  recall's recent/lexical legs cover the gap). Without it the vector write is awaited as before. */
  remember(agentId: string, text: string, concepts?: string[], opts?: { waitUntil?: (p: Promise<unknown>) => void }): Promise<string>
  recall(agentId: string, query: string, limit?: number): Promise<MemoryHit[]>
  /** Newest engrams in ONE scope (read-your-writes; does not depend on the vector index). */
  recent?(agentId: string, limit?: number): Promise<MemoryEngram[]>
  /** One engram by id, ONLY if it lives in `agentId`'s scope; null for missing and foreign alike. */
  get?(agentId: string, id: string): Promise<MemoryEngram | null>
}

export type MemoryHitSource = 'vector' | 'recent' | 'lexical'

export interface MemoryHit {
  id: string
  text: string
  score: number
  /** Which retrieval leg produced the hit (vector index, D1 exact substring, D1 recently written). */
  source?: MemoryHitSource
}

export interface MemoryEngram {
  id: string
  text: string
  concepts: string[] | null
  created_at: string
}

export interface BusPort {
  emit(event: BusEvent): Promise<void>
}

// ── Model port — connect-your-model (the brain/agents think through this) ──
// CF profile routes through AI Gateway (Anthropic/OpenAI/Google) or Workers AI,
// or a tenant-supplied key. The agent never hardcodes a provider.
export interface ModelMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

// ── Model port (substrate-contract.md §kernel ports). Version lives as a module
// constant, NOT a field on the interface, so adapters/mocks stay structural and
// the parent still knows the contract version. Adding optional ModelChatOpts
// fields is additive (no version bump); changing chat()'s shape is a v2 + shim.
export const MODEL_PORT_VERSION = 1 as const

export interface ModelChatOpts {
  model?: string
  maxTokens?: number
  temperature?: number // additive v1-optional
}

/**
 * Token usage — DISJOINT convention (River gate P1-3): `input` is the NON-CACHE
 * input only. cacheRead/cacheWrite are separate fields; summing input + cacheRead
 * would double-bill every cached token. Producers that see a total prompt_tokens
 * (DeepSeek) MUST subtract the hit before setting `input`.
 */
export interface TokenUsage {
  readonly input: number
  readonly output: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
}

export interface ModelChatResult {
  /** The assistant's text reply. */
  text: string
  /**
   * Token usage reported by the provider on this call. Optional because not every
   * transport surfaces it (Workers AI fallback, some gateway providers).
   * cacheRead/cacheWrite are only present when the provider reports them
   * (e.g. DeepSeek's prompt_cache_hit_tokens / prompt_cache_miss_tokens).
   */
  usage?: TokenUsage
}

export interface ModelPort {
  chat(messages: ModelMessage[], opts?: ModelChatOpts): Promise<string>
  /**
   * chatWithUsage — like chat(), but also returns the provider's token usage
   * (cache hit/miss split when the provider reports it). ADDITIVE: mocks that only
   * implement `chat` remain valid (structural typing); callers that need real
   * usage for metering use this method and fall back to estimates when it is
   * absent or usage is undefined.
   */
  chatWithUsage?(messages: ModelMessage[], opts?: ModelChatOpts): Promise<ModelChatResult>
}

// ── Brain port (substrate-contract.md §kernel ports). RANK-ONLY: the brain reads
// a context snapshot and returns a RANKING of proposals — it NEVER acts. The
// sealed core applies the ranking through the autonomy + capability + budget
// gates. This is what makes brain-swapping (sovereign C(t) #70, a YC-CEO brain,
// BYO) safe: a swapped brain changes WHAT is proposed, never bypasses a gate.
// Idempotent by contract: a stable BrainContext should yield a stable ranking
// (rank, don't act → same state → same answer → no spam).
export const BRAIN_PORT_VERSION = 1 as const

// JSON-only, capability-free by TYPE. BrainContext is a SANITIZED snapshot — raw
// bus/event payloads, Env handles, bindings, or secrets must never cross the brain
// port. `unknown` would defeat that by convention; BrainJson enforces it at the
// type level (a binding/secret object cannot satisfy this type).
export type BrainJson =
  | string
  | number
  | boolean
  | null
  | readonly BrainJson[]
  | { readonly [k: string]: BrainJson }

export interface BrainContext {
  tenant: string
  goals: ReadonlyArray<{ agentId: string; okr: string; kpiProgress: number }>
  board: ReadonlyArray<{ taskId: string; status: string; agentId: string | null }>
  pulses?: ReadonlyArray<{ kind: string; at: number; payload?: BrainJson }>
  lastHumanDirective?: string | null // position-0 of every decision (bus WAKES, never STEERS)
  budgetRemainingMicroUsd?: number
}

export interface BrainProposal {
  kind: 'spawn_task' | 'wake_agent' | 'noop'
  agentId?: string
  summary: string // human-readable intent (audit trail / Brain page)
  doneWhen?: string // proposed done-condition; core still gates
  priority: number // brain's rank; core may re-clamp
}

export interface BrainDecision {
  ranked: ReadonlyArray<BrainProposal> // ordered best-first; idempotent for a given context
  rationale?: string
}

export interface BrainPort {
  decide(ctx: BrainContext): Promise<BrainDecision>
}

// key/value org settings (onboarding state, chosen model provider, brand, …).
export interface OrgSetting {
  key: string
  value: string
  updated_at: string
}

// ── Channels (microkernel: a tiny core + swappable platform adapters) ──
// The platform's scoped channel IS the squad. The CORE knows zero platform
// specifics — it only speaks this interface; each platform is a leaf adapter
// registered by key. channel↔squad and platformUser↔member live in D1.
export interface ChannelBinding {
  id: string
  platform: string // 'discord' | 'google-chat' | 'telegram'
  external_channel_id: string
  squad_id: string
  max_capability: Capability // ceiling for membership-sync grants (default 'member')
  created_at: string
}

export interface MemberIdentity {
  id: string
  member_id: string
  platform: string
  external_user_id: string // Google: email; Discord/Telegram: platform user id
}

export interface ChannelCapabilityGrant {
  id: string
  binding_id: string
  member_id: string
  squad_id: string
  capability: Capability
  created_at: string
  updated_at: string
}

// Normalized inbound message — what every adapter's parseInbound returns.
export interface InboundMessage {
  platform: string
  externalChannelId: string
  externalUserId: string
  text: string
}

// The microkernel seam. A platform adapter is a leaf plugin; the core depends
// ONLY on this interface, never on a concrete platform.
export interface ChannelAdapter {
  platform: string
  verify(req: Request, env: Env): Promise<boolean> // webhook authenticity, fail-closed
  parseInbound(req: Request, env: Env): Promise<InboundMessage | null>
  post(env: Env, externalChannelId: string, text: string): Promise<void>
  listChannelMembers(env: Env, externalChannelId: string): Promise<string[]> // external user ids
  roleCapability?(
    env: Env,
    externalChannelId: string,
    externalUserId: string,
  ): Promise<Capability | null> // platform role → capability (optional)
  // optional: own the HTTP response for platforms that reply INLINE (Discord
  // interactions: PING→PONG, slash command → {type:4}). The core passes `run` —
  // the resolve→gate→act pipeline — so the adapter can act and shape the inline
  // reply without importing the core (microkernel intact). Return null to fall
  // through to the out-of-band post() path (Telegram, Google Chat, Hermes relay).
  respond?(
    req: Request,
    env: Env,
    run: (inbound: InboundMessage) => Promise<string>,
  ): Promise<Response | null>
}

// ── Component routers register onto the root Hono app under these prefixes ──
export const ROUTES = {
  auth: '/auth',
  org: '/api/org',
  agents: '/api/agents',
  tasks: '/api/tasks',
  projects: '/api/projects',
  bus: '/api/bus',
  members: '/api/members',
  mcp: '/mcp',
  im: '/im',
  dashboard: '/',
} as const
