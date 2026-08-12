# FLIGHT-001 — DETECTION report (Prime, DETECTION phase)

Trigger: Hadi 2026-08-07 — random email → member → "all menus and all agents" on a live
pot. Division of labour: Prime detects → Kasra adjudicates → Hadi authorises destructive
fixes. READ-ONLY discovery: no test accounts minted, no tokens minted/revoked, no
deactivation, no mutations. Live probes used EXISTING credentials only
(kasra-agent.token member-tier, kasra-admin.token org-admin, plus labelled-revoked
cursor token as a negative control) against https://mupot.mumega.com (commit 3772d973).
Calibrated recall 4/6: assume gaps; each CONFIRMED needs Kasra's adjudication.

Method per hypothesis: source + live-surface where the surface answers. "Surface" answers
what the pot RETURNS, not what it intends.

================================================================================
H1 — MEMBER TIER IS TOO BROAD (Hadi's live report) — CONFIRMED (dashboard surface)
================================================================================
Verdict: CONFIRMED. A bare authenticated member sees ALL menus and ALL org data on the
web dashboard. The MCP/bearer surface is properly scope-gated (verified live). The two
surfaces disagree: API gates, dashboard pages do not.

Deciding evidence (source):
- Dashboard auth gate is requireAuth ONLY + tenant match — no role/capability floor:
  src/dashboard/index.ts:228-246 (`dashboardApp.use('*')`).
- Sidebar nav renders every menu for every authenticated user; only "Addons" is
  admin-only (hidden, revealed by src/dashboard/index.ts:251-257). Nav: 3430-3559.
- GET / (overview) renders the FULL agent roster: loadObservatory has NO capability
  filter — src/dashboard/observatory.ts:296-315 (SELECT all agents + all recent tasks).
- GET /agents renders loadAllAgents: every agent incl. OKR/KPI/budget/spend/current-task
  and review-task titles, no filter — src/dashboard/agents-admin.ts:69-134;
  route src/dashboard/index.ts:1204-1221 (only the Add form is isOrgAdmin-gated).
- GET /members renders the FULL member roster (emails), channels, and LIVE token
  inventory (id/member_id/label/channel) to any authenticated member —
  src/dashboard/index.ts:2036-2047 + loadLiveTokens (src/members/service.ts:328-334).
- GET /squads/:id renders the squad board with ALL of the squad's tasks with NO
  capability check on read (canAddAgent/canManage only hide buttons) —
  src/dashboard/index.ts:1321-1355.
- GET /send renders all active agents (src/dashboard/index.ts:636-650); GET /flights
  renders listFlights for all (1050-1063); GET /fleet renders the full presence roster
  (1096-1116); GET /coordination renders the departures board (1186-1196).

Random-email → member mechanics (source):
- Web login: upsertUserByEmail — first user EVER becomes owner, everyone after defaults
  to member with NO allowlist/invite check: src/auth/index.ts:559-604 (`isFirst &&
  allowBootstrapOwner ? 'owner' : 'member'`); OAuth callback at :423-466. A verified
  Google email is sufficient; no tenant-domain allowlist.
- OAuth/agentic door: findOrCreateMember creates an ACTIVE members row for ANY verified
  email — src/mcp/oauth-authorize.ts:111-127, rate-limited only at 5/hr/IP
  (oauth-authorize.ts:317-336). The member row then feeds the dashboard email→member
  bridge (src/auth/index.ts:687-717) and the /members roster.

Member-tier MCP surface (live-verified as SCOPED — the counter-evidence):
- POST /actions/status with kasra-agent.token → member@2 squads only (squad-core +
  813ca010), role=member. No org grant.
- Cross-squad probes with the member token on a squad it does NOT hold (hadi squad
  8b5eb133): peers 403 forbidden · task_list 403 forbidden · orient 403 forbidden.
  With the org-admin token on the SAME squad: all 200.
- AAGATE floor at src/mcp/index.ts:3084-3091 (holdsCapabilityFloor before any handler);
  per-tool scope checks (resolveScopedSquad :518-541; orient gate :2731-2732; status
  gate :2555-2558; peers gate :2407-2414).
- /api/members API is properly gated at org-scope member — src/members/index.ts:410.

Consequence: an invited-or-random member = org-wide READ on the dashboard (agents,
budgets, spend, OKRs, tasks, members' emails, token inventory), plus org-wide reads on
MCP only where grants exist. The dashboard read surfaces never consult grants.

Fix shipped: none (detection phase; this flight ships fixes after adjudication).
Named reason for the gap: the dashboard was built as an operator console with
requireAuth-only gates; per-surface capability filtering was never applied to its READ
handlers (only to mutating ones and to /admin/* pages).

================================================================================
H0 — PRESENCE-CONDITIONED AUTHORITY (seed seat) — CONFIRMED (mechanism) +
      DELTA ENUMERATED
================================================================================
What the presence signal IS:
- The seed seat is the owner's MEMBER identity (hadi → owner@org; the seed map
  src/members/squad-seed.ts:40-60 and first-user-owner src/auth/index.ts:604).
- The gateway (kayhermes) is a bound IM/channel agent. "Presence" = a message arriving
  from the owner's mapped platform identity. Identity is resolved from the server-side
  mapping ONLY: IM chat.id → members.telegram_chat_id (src/im/index.ts:92-98, 304-310);
  channel platform-user → member_identities (src/channels/index.ts:84-100, 370-380).
- The seam is the documented "I act as you, with your permissions" —
  src/channels/index.ts:205, src/im/index.ts:278. The gateway relays the member's
  intent and the pot authorizes it with the MEMBER's capabilities (owner@org for hadi).
- When the owner is not messaging, kayhermes acts with its OWN token: verified live —
  kayhermes-member.token → member@ squad-core only, bound to agent 942e2845. So the
  entire difference between "the owner" and "an agent" is ONE signal: which platform
  identity the inbound message is mapped to.

Can it be spoofed? — NO by message text (identity is NEVER read from text; the payload's
chat.id is only a lookup key). YES by a forged webhook IF a shared secret leaks:
- IM webhook: authenticity = a single shared secret X-Telegram-Bot-Api-Secret-Token ==
  IM_WEBHOOK_SECRET (src/im/index.ts:786-792; telegram adapter src/channels/adapters/
  telegram.ts verify). With that secret, ANY chat.id can be asserted — including the
  owner's → full owner impersonation.
- Channels /relay: HERMES_RELAY_SECRET header (src/channels/index.ts:493-497); Hermes
  vouches for externalUserId. A compromised relay = any member impersonation.
- Discord: Ed25519 signature verify (fail-closed) — cryptographically bound.
- Google Chat: JWT verify against Google x509 (fail-closed) with an OPTIONAL weaker
  shared-token fallback when GOOGLE_CHAT_PROJECT_NUMBER is unset
  (src/channels/adapters/google-chat.ts).
- Forwarded-message guards exist for the highest-authority IM intents — fleet
  (src/im/index.ts:453-455) and directive (src/im/index.ts:672-674) — but NOT for
  verdict or task creation.

Does it expire? — NO. The member_identities/telegram_chat_id mapping and the capability
grants have no TTL; every message re-resolves identity fresh. The web session cookie
expires at 7 days (SESSION_TTL_SECONDS, src/auth/index.ts:29) and the KV presence marker
(auth/index.ts:99-111) is a Control-Tower hint, NOT authorization — nothing reads it for
capability. An owner who walks away leaves the mapping armed; the next message from that
chat is still owner authority.

Is it revocable? — YES, manually: suspend the member (src/members/index.ts:434),
revoke tokens (:491), or unlink the platform identity (admin action). Nothing auto-revokes
presence; there is no per-message cooldown.

THE DELTA (blast radius — what the seed seat can do WITH owner authority vs without):
WITH owner@org (hadi present via the seam):
  - Passes EVERY capability check at every rank on EVERY scope (org grant covers all;
    src/auth/capability.ts:52-68 hasCapability org branch).
  - Dashboard: isOrgAdmin → all /admin/* pages, token mint, invites, grants,
    departments/squads/agents create (dashboard/index.ts:1224-1253, 1393-1452,
    members/index.ts:356-405, 434-518).
  - Wake ANY agent in the org (lead+ on any squad is satisfied by org owner —
    src/agents/index.ts:82-89, mcp wake_agent :1986).
  - flight_dispatch with budget (lead requirement met — mcp/index.ts:1505-1514).
  - IM: fleet host control (owner gate, src/im/index.ts:414-416), pin brain directive
    (owner gate, :591-594), approve/reject any gate verdict (org-admin bypass, :492-494).
  - Every floor-gated MCP tool (holdsCapabilityFloor, mcp/index.ts:3089).
WITHOUT (kayhermes's own identity, member@ squad-core):
  - member+ actions scoped to squad-core only: task create/list/update on that squad,
    peers, squad_recall, orient on squad-core agents, squad_message.
  - 403 on: every other squad (VERIFIED LIVE: peers/task_list/orient on hadi squad
    8b5eb133 with the member token), wake_agent (lead needed), fleet control, directive,
    verdict bypass, admin pages, mint, grants.

Does anything log the elevation? — NO. Bus events carry actor {kind:'member', id}
(im/index.ts:390-399, channels/index.ts:292-301) — correct attribution of WHO, but no
"seat elevated to owner" event. The audit log (src/dashboard/audit.ts:5-12) covers ONLY
connector_audit + task_verdicts; bus events go to a CF Queue (src/bus/index.ts:37-47),
not to any queryable audit store. A privilege transition via this seam is invisible in an
incident.

Deciding evidence: live token resolution (kasra-agent vs kasra-admin delta on 8b5eb133),
source seam files above. The actual chat→hadi binding row was NOT inspected (no member
enumeration available read-only); Hadi's report is consistent with the mechanism.

================================================================================
H2 — AMBIENT AUTHORITY AND SCOPE BLEED — CONFIRMED on the dashboard;
      REFUTED on MCP/IM/channels
================================================================================
- Directory (OAuth) channel: zero ambient authority BY CONSTRUCTION — capabilities = []
  for channel==='directory' (src/mcp/oauth-authorize.ts:268-272 B1); injected-context
  seam re-derives capabilities server-side and zeroes non-channel blobs
  (src/mcp/index.ts:137-173). The client-supplied header cannot survive: the internal
  boundary uses headers.set() to OVERWRITE it (src/mcp/internal-dispatch.ts).
- Workspace/IM/channel surfaces: callers carry their REAL grants and every tool/intent
  re-checks scope (resolveScopedSquad :518-541; IM intents gate per capability —
  wake lead+, fleet owner, directive owner, verdict admin/gate-grant, task member+squad).
- DASHBOARD is the exception (the H1 root): no per-surface scoping on read handlers —
  an authenticated member sees every squad's agents/tasks/members/tokens regardless of
  grants. One compromised session = org-wide read + the member's own write grants.
- Cross-squad on MCP: verified live 403 for out-of-grant squads; squad_id is not
  authorizing (peers/task_list/orient all scope-check).

================================================================================
H3 — TOKEN SCOPING AND CREDENTIAL EXPOSURE — CONFIRMED (design facts) +
      partial UNPROVEN (rotation semantics)
================================================================================
- member_tokens have NO expiry column — long-lived until revoked
  (migrations/0002_members.sql:17-29). Per-token scoping = channel enum
  (workspace/im/dashboard/directory, 0020) + optional agent weld (0019) only; a token
  carries the MEMBER's full capability set. Per-key scope-DOWN is explicitly deferred to
  v0.26 (src/dashboard/keys.ts docstring); minting ATTESTs never GRANTs (keys.ts:138-205).
- Revocation IS effective at every request: authenticateMember joins
  `t.revoked_at IS NULL` (src/mcp/index.ts:234-249). LIVE PROOF: the cursor token
  labelled revoked 2026-07-30 now returns 401 unauthenticated (negative control probe).
- OAuth access tokens are provider-managed (expire per OAuth); the pot re-checks the
  underlying member_tokens row liveness every request (oauth-api-handler.ts).
- CF-side: per AGENTS.md a 131-permission, never-expiring, mint-capable key was revoked
  2026-08-07; TWO other mint-capable CF tokens remain — out of this repo's code; tracked
  in docs/security/cloudflare-key-registry.md. NOT re-verified live (would need CF access).
- UNPROVEN: rotation semantics end-to-end (mint-new+revoke-old against a live minted
  token) — requires a mutation, not performed. Secrets inventory: docs/security/
  secrets-inventory.md.

================================================================================
H4 — INDIRECT PROMPT INJECTION — PARTIALLY CONFIRMED (structural fences exist;
      the relayed-authorization rule is convention, not code)
================================================================================
Structural (enforced in code):
- Prompt fence: asData/sanitizeInline strips C0/C1 controls, U+2028/29, bidi overrides —
  src/lib/prompt-safety.ts; used by sensorium/execute/episodic/collectors/loops.
- Externally-sourced tasks get untrustedContentGuard + are excluded from the
  content-publish short-circuit (src/agents/execute.ts:139-177, 216-224).
- Gate protocol: verdicts are append-only (D1 triggers, migrations/0008), gate authority
  is gate_grants + owner/admin bypass (src/tasks/index.ts callerHoldsGateCapability).
- Forwarded-message guard on the highest-authority IM intents (fleet only,
  src/im/index.ts:453-455; directive, :672-674; verdict/task paths have no forward guard).
Not structural (convention only):
- "A relayed authorization claim is not authorization" (the Dara precedent) is NOT
  enforced anywhere in code — no surface rejects content that *claims* an authorization.
  It holds today only because every effect is capability-gated and gated effects need a
  gate_grants row or owner/admin. Content embedded in email/web/squad notes can still
  steer tool calls within the agent's legitimate authority.
- Deciding evidence: grep of src for authorization-claim handling found none beyond
  capability gates; src/lib/prompt-safety.ts exists and is applied at the listed sites.

================================================================================
H5 — RESOURCE AND EXECUTION LOOPS — CONFIRMED (partial; two named gaps)
================================================================================
- Budget enforcement at dispatch: YES for agent cycles — meter.checkAndReserve runs
  BEFORE every model call (src/agents/execute.ts:192-196, loop.ts:294-303) and gates
  the cycle (rate_limited/budget_exhausted). Routine runs enforce budget_micro_usd
  (src/routines/dispatch.ts:486). Flight budgets: ceiling = min(agent, all referenced
  squads) × caps, enforced at dispatch (src/mcp/index.ts:1536-1546); member may dispatch
  only budgetless (0) flights (lead+ required for a funded one, :1505).
- GAP 1: the cap applies to agents.budget_cap_cents ONLY; squad caps are NOT enforced on
  cycles, and a NULL agent cap = unlimited (src/agents/meter.ts:72). Live: kayhermes
  budget_cap_cents = null (orient packet) — the seed agent is uncapped.
- GAP 2: wake paths are NOT rate-limited (documented as future work —
  src/agents/index.ts:71 "Rate-limit before self-serve tenants"). lead+ can drive
  repeated cycles; wake_agent maxActions is clamped only at ≥0, never above
  (src/mcp/index.ts:1994-1997, agent-do.ts:250) — a caller can ask for N tasks per wake.
- Depth limit: no nested-flight/task depth counter found in the pot (flight dispatch has
  preflight + clearance gates only) — UNPROVEN for harness-side recursion.
- The 12→24 turn-cap blow is harness-side (fleet-runtime/hermes), NOT in this repo;
  the pot bounds each model call at EXECUTE_MAX_TOKENS=2048 (src/agents/execute.ts:55).

================================================================================
H6 — DUPLICATE AGENT IDENTITIES — CONFIRMED (live roster)
================================================================================
- CONFIRMED live: duplicate slug 'kasra' — c855f82c (squad-core, ACTIVE) and ea2b0370
  (813ca010/mmhq, INACTIVE). Matches AGENTS.md exactly; ea2b0370 is the ghost identity
  that parks routine dispatch in waiting(agent) (AGENTS.md ops state).
- Slug resolution is fail-closed: resolveAgentRef refuses a slug matching 2+ NON-INACTIVE
  rows and excludes tombstones (src/org/resolve.ts:39-42, #702) — the live kasra pair
  resolves only because the dupe is a tombstone. A second LIVE dupe would poison every
  slug reference (fails closed: 'ambiguous').
- Near-duplicates on the visible roster: hadi-claude / hadi-codex / hadi-hermes,
  codex / codex-mac-mumcp, cursor / cursor-auto / cursorlive, spark-a / spark-b,
  mubot / agent-hermes ("Hermes runtime" twins).
- UNPROVEN beyond the 2 readable squads: 27 agents visible of the full roster; full
  duplicate census requires admin read (no read-only member enumeration).
- The tombstone keeps its slug forever (UNIQUE(squad_id, slug)) and its engrams;
  deactivation is Hadi-authorised, one batch, with roster diff before/after (per brief).

================================================================================
WHAT I DID NOT CHECK (explicit)
================================================================================
- Any mutation: no token mint/revoke, no capability grant, no invite, no wake, no
  deactivation, no task writes. All live probes were read-only tools
  (status/boot_context/peers/orient/task_list/squad_recall) or unauth GETs.
- The dashboard with a real random-email session: creating one = minting a test account
  (forbidden). The dashboard findings rest on source + the requireAuth-only gate; the
  live MCP surface was probed instead.
- The actual chat→member binding rows for hadi/kayhermes (needs admin read; not
  available via bearer) — the mechanism is source-confirmed, the live binding row is not.
- Directory-channel (OAuth) live behavior: no directory token on this host; verified in
  source (B1 ceiling + boot_context directory note).
- IM_WEBHOOK_SECRET / HERMES_RELAY_SECRET strength and presence in prod (Worker
  secrets — not inspectable here). Their compromise = full member impersonation (H0).
- CF token estate (two remaining mint-capable keys): needs CF API access; AGENTS.md +
  docs/security/cloudflare-key-registry.md are the record.
- Harness-side turn caps / flight depth limits (the 12→24 turn blow): not in this repo.
- Full H6 duplicate census beyond the two squads readable with a member token.

================================================================================
SEVERITY RANKING (by what an attacker can do in production TODAY)
================================================================================
1. H1 dashboard read-broadcast (random verified email → org-wide roster/tasks/members/
   token inventory; no allowlist) — the reported symptom; read-only but tenant-wide.
2. H0 presence seam: the delta between agent and owner is one shared-secret-gated message
   mapping; a leaked IM/relay secret = full owner impersonation; elevation is unlogged.
3. H5 wake/budget gaps: uncapped seed agent (budget NULL), no wake rate limit, unbounded
   maxActions — operator-driven burn, not attacker-driven without a lead grant.
4. H6 duplicate identities: live kasra tombstone still parks routines; fail-closed slug
   resolution means no chance-based authority today.
5. H3: revocation proven live; token expiry absent (long-lived by design) — moderate.
6. H4: prompt fences + gate protocol structural; relayed-authorization refusal is
   convention only — moderate.
