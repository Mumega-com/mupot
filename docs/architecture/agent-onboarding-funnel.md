# Agent onboarding funnel: trace, state machines, friction list

Mission (Hadi, 2026-10-15): a new agent arriving at mupot finds its way to productive work the way
lightning finds ground. Every step tells the agent the next step. No dead ends. No human hand-holding
except the one approval tap.

**Method.** Read-only trace of the code on `origin/main` @ `32a8f146`, plus three live reads of
`https://mupot.mumega.com` (the unauthenticated edge). Ground truth beats docs: every claim cites
`file:line` at that commit unless it says "live". Line numbers in this document are pre-fix numbers for
`src/mcp/index.ts`; the fixes in this PR shift later lines by a few. Flag state is deployment config and is
deliberately not recorded here.

**Not in scope, planned (do not read these as done):**

- mupot #1937, in flight on `kasra/attached-mark-handled`: attached chats may mark mail handled and
  `inbox_consumer_status` tells the truth for attached callers. Funnel step A8 below depends on it.
- S2, planned: a "Make this the agent's home" choice on the passkey approval page that turns an
  attachment into the agent's host seat. Funnel step A9 is a placeholder for it.

**Flags that decide which funnel a human gets** (per deploy config; names only, values are deployment-specific): `SEAT_AUTO_ENROLL`, `SEAT_ATTACH`, `SECURE_MOMENTS`, `ACCESS_APPROVE_ENABLED`, `WEBHOOK_DOORBELL`, `EVENTS_ENABLED`, `SHARED_CREDENTIAL_DETECT`, `WORKSPACES`. Check a pot's own `tools/list` and consent screen to see which are on.

---

## 1. What an agent sees, in order (the trace)

### 1.0 Before any door: the cold URL

A brand-new agent given only a URL finds nothing machine-readable. Live, 2026-10-15:

- `GET /` returns the human sign-in HTML.
- `GET /llms.txt` and `GET /.well-known/mcp.json` answer `302` to sign-in.
- `POST /mcp` unauthenticated answers `401`, `www-authenticate: Bearer ... resource_metadata=".../.well-known/oauth-protected-resource/mcp"`, body `{"error":"invalid_token"}`. The resource metadata lists scopes only; nothing says "to onboard, read X".
- `GET /openapi.json` answers a public subset of tools (`src/mcp/openapi-public-allowlist.ts`), no onboarding text.
- The initialize `instructions` are the real first-contact text, but the public endpoint answered an unauthenticated initialize with `401` (live; deployment behaviour of the OAuth front layer, not a handler guarantee, since the handler treats initialize as bearerless), so a cold agent did not reach them. The comment at `src/mcp/instructions.ts:3` is reworded in this PR to say both and to keep the static-payload rule explicit.

So the first guidance any agent can read is delivered only after a human has already connected it.
There is no door where an agent can read "start here" without credentials.

### 1.1 What the handshake and the first calls say

| Surface | Source | What it says | Gap |
|---|---|---|---|
| initialize `instructions` | `src/mcp/instructions.ts:14-70` | 9 sections: boot first, B1 ceiling, `bootstrap_self` for new agents, reconnect for existing, tokens vs connectors, error decoding, bus ACK, tasks, 7-axis `check_in` | Before this PR: never named `seat_attach`; sent every new chat to `bootstrap_self` (line 25), which a seat session cannot run; said nothing about finding work |
| `boot_context` | `src/mcp/index.ts:6540-6790` | `onboarding_state` (bound / unbound_no_agent / unbound_agent_exists / unbound_workspace, line 6332-6345), `available_doors` (6377), `next_step` (6659-6670), `channel_limits` (6691-6727), `enroll_url` | A seat session is `bound`, so its doors were orient/status/boot_context only; `seat_attach` appeared only inside `channel_limits.to_get_write_access` (6711-6722), the last field read |
| `orient` | `src/mcp/index.ts:6796-6860`, `src/orient/service.ts:142-215` | The basin-drop brief: scope, supervisor, open tasks, rails | Empty task list printed "ask your supervisor or check the project board" (service.ts:142): no tool name. Rails say "write work to GitHub issues", not the pot's task tools |
| tool descriptions | `src/mcp/index.ts` `mcpTool` (scope + `minimum capability` + `Args`) | One line per tool, ~119 tools (comment at index.ts:6613) | No grouping, no "call this next". The registry is a flat list |
| generic refusal | `src/mcp/index.ts:7494`, `mcpToolRefusalResult` 7286 | `forbidden { need: <floor> }` only | No next step on the single most common refusal on every door. Fixed in this PR for the MCP envelope |

### 1.2 Door (a): ChatGPT / Claude / Grok chat with the OAuth connector

1. Human adds the pot's `/mcp` URL as a connector. `401` challenge starts OAuth. Human signs in (Google or email).
2. Consent screen, "How will this app connect?" (`src/mcp/oauth-authorize.ts:913`): **Many chats** (the suggested option for ChatGPT, Claude, Cursor, Grok by redirect host or client name, `src/mcp/consent-connect-mode.ts:15-33`) or **One agent**. Nothing is pre-checked (the radio is `required`, never preselected). Choosing Many chats upserts a harness row and issues an unbound directory grant (`oauth-authorize.ts:1999-2013`). Only exists while `SEAT_AUTO_ENROLL=1`.
3. First tool call. ChatGPT: the request carries `params._meta["openai/session"]`, and the server mints an auto seat agent for that conversation with no model action (`src/members/seat-auto.ts`; only `openai/session` and a Codex `threadId` are recognised, `pickAutoSeatKey`). Claude web: no recognised key, so the session stays a *harness session* that can call only `seat_select`, `boot_context` (and `worktree_open` if enabled) (`src/members/harness-credential.ts:28`); anything else answers `harness_session_seat_required` (message at line 31, names `seat_select`).
4. `boot_context`. For a harness session: `next_step` says call `seat_select` (index.ts:6630-6671). For an auto seat: `bound`, `next_step` says call `orient`.
5. `seat_select { project }` (Claude web) returns an `mseat_` handle to send as `X-Mupot-Seat` or `_meta["mupot/seat"]`. The seat agent is capped at member and at the human's own access.
6. `orient`. Brief with an empty task list (new seat agent): dead end before this PR.
7. To act as an existing agent (Rava, a project agent): `seat_attach { agent }` (`src/mcp/seat-attach.ts:33-100`). Only a seat session may call it (line 37-39, else `seat_required`). The agent name resolves only among agents the human administers. First time: files a pending admission (24 h TTL, `src/members/seat-attach.ts:54`) and returns `approve_url`.
8. Human opens `approve_url` (a one-time secure-moment link on the dedicated host), picks a level (Member/Lead/Full) and taps their passkey (`src/secure-moments/routes.ts:422-440`). If the human has **no passkey yet**, the page cannot enrol one (by design, routes.ts:514-516); the only hint is the "no prompt" help line pointing at My Account (routes.ts:517-526). Neither the tool note (mcp/seat-attach.ts:76-78) nor the approval page's first screen says "enrol a passkey first".
9. The approval page returns "Admitted ... Paste the message below into the chat that asked" (`src/members/seat-attach.ts:448`). The human must carry a pasted message back into the chat: the agent has no way to learn the admission was decided except calling `seat_attach` again.
10. `seat_attach` again returns `attached`; the next request acts as that agent. `boot_context` shows `identity_receipt.binding_source: attached_seat`.
11. Acting as the agent: attached chats are peek-only on mail (`attached_seat_peek_only`, index.ts:4952, 5079, 5176). They can read the inbox but never clear it, while `inbox_consumer_status` reports `bearer_only` (index.ts:5403) which implies consumption works. That is mupot #1937, planned fix in flight.
12. (Planned, S2) "Make this the agent's home": the approval page offers to make the attachment the agent's host seat, which would settle the peek-only question for an agent whose only runtime is a chat.

Where it gets stuck (door a): no door at all on a pot without the flags (section 4, F1); a Many-chats chat told to run `bootstrap_self` (instructions.ts:25) answers `not_unbound_directory_session` (`src/members/bootstrap-self.ts:348-349`: a seat is agent-bound) with a message that says "already has a voice" and offers nothing; empty orient; human without a passkey; human not told to paste the approval message; pending admission re-ask returns no link (`seat-attach.ts:260,280` `approveUrl: null`) so a chat that lost the link must send its human to the Connections page.

### 1.3 Door (b): a CLI harness (Codex, Claude Code, Hermes) on a server with a bearer token

1. A human with admin on the agent's squad mints the credential. Two routes (`docs/connect-mcp-client.md:45-62`): Dashboard Connect card (show-once) or `mint_agent_token` then `reveal_credential_claim { claim_id }` within 600 s. The agent cannot self-mint (the structural chokepoint refuses it, `agentLane 'refuse'`). A new agent can instead call `bootstrap_self` only from an unbound directory session, which a CLI is not.
2. Human puts the token in a protected env var and writes `.mcp.json` / `config.toml` with `type: http` (`docs/onboarding/add-an-agent.md`). `type: sse` or a newline-wrapped token fails as a bare `401` (`connect-mcp-client.md` troubleshooting).
3. `initialize` returns the instructions. `boot_context`: a minted agent token is `bound`, `next_step` = call `orient` (index.ts:6659). A member token that is not agent-bound is `unbound_workspace` and gets `connect` or `mint_agent_token` (index.ts:6405-6415) with prose "ask an org-admin" (6665): **no name, no channel** for asking.
4. `orient`. Brief; with no assigned tasks the empty state (fixed: now names `task_board` / `task_list`).
5. `check_in` with the 7-axis identity (instructions item 9). A polling runner adds `presence_mode: "poll"` (`docs/playbooks/runner-onboarding.md` step 2; refused without an agent-bound credential, index.ts:5737).
6. Find work: `inbox { peek: true }`, `task_list { assignee_agent_id: <self> }`, `task_board`. Before this PR the handshake never listed these.
7. Report: `runner_record`, `task_update`, `task_submit_result` (needs `Artifact:` and `SHA256:` lines, instructions item 8), and `task_dispatch_runtime_receipt` for dispatched work (runner playbook step 5).
8. Being reachable (not just sending): `docs/host-a-seat.md` (bridge + Stop hook, one consumer per inbox). Sending works with the token alone; receiving needs the bridge.

Where it gets stuck (door b): step 1 needs a human admin but nothing the agent sees names how to ask; `not_agent_bound` on `send`/`inbox` for a member token (documented in `host-a-seat.md`, answered bare in code); runner playbook step 1 says "an admin on the agent's squad" with no route.

### 1.4 Door (c): a webhook or bot endpoint

Two shapes, no onboarding doc for either in one place.

*Outbound wake (the pot rings the bot's doorbell).* Source: `docs/plugins/grokbot-webhook-spine.md`.

1. Agent exists with a credential (door b step 1 first).
2. Bot author builds a routine that peeks `inbox { peek: true }` and `task_list { status: "open" }` (doc, "Operator" step 1).
3. A human admin registers URL + key at `/doorbells` (fresh session within 30 minutes). A human cannot do it over a bearer: `dashboard_only` (`src/mcp/webhook-doorbell.ts:89`); an agent-bound caller may set its own, but an attached chat may not (line 53).
4. "Send test ping" shows the HTTP status. Wake bodies carry ids only.
5. Flag off: `webhook_doorbell_disabled` with detail "set WEBHOOK_DOORBELL=1 to enable" (line 117). That text addresses the *operator*; the agent that hits it is told to change server config it cannot touch, with no human named.

*Inbound (an external service calls the pot).* `POST /actions/<tool>` with a bearer (`connect-mcp-client.md:140-171`); discovery is `GET /openapi.json` (public subset, live) and `/openapi.full.json` (org-admin only). A non-MCP bot has no initialize handshake, so none of the instructions, `boot_context` doors or `next_step` text ever reach it unless it calls `boot_context` through `/actions` by name.

---

## 2. Funnel state machines

One deterministic path per door. Each row: `state` -> the single next action -> tool -> success signal -> failure signal -> exact recovery.
State ids are stable names so `boot_context` can adopt them as a `funnel.state` field (proposal P1); today only the `onboarding_state` subset exists.

### 2.1 Door A: chat connector

| State | Single next action | Tool / surface | Success signal | Failure signal | Exact recovery |
|---|---|---|---|---|---|
| A0 `no_connector` | Human adds the `/mcp` URL as a connector | chat app settings | OAuth consent screen opens | client enters `/authorize` loop or `401` | URL must be the pot's `/mcp`; Troubleshooting table in `connect-mcp-client.md` |
| A1 `consent` | Human picks **Many chats** (or **One agent** for a single bot) | consent screen | redirect back; connector shows tools | no "Many chats" choice shown | pot lacks `SEAT_AUTO_ENROLL=1`: owner sets it (`wrangler.example.toml` now documents it) and redeploys |
| A2 `first_boot` | `boot_context` | MCP | `onboarding_state`, `available_doors` | none (always answers) | read `next_step` |
| A3a `harness_no_seat` (Claude web) | `seat_select { project }`, then send the handle | MCP | `seat_handle` (`mseat_...`) | `seat_auto_enroll_disabled` / `rate_limited` / `seat_cap_reached` | re-boot; `rate_limited` and `seat_auto_enroll_disabled` now carry a `next_step` (`seat_cap_reached` is NOT covered: its detail is the only text); owner raises caps or retires seats |
| A3b `auto_seat` (ChatGPT) | none: already a seat | server | `identity_receipt.binding_source: auto_seat` | `auto_seat_refused` on the receipt | retry; refusals are cached 30 s |
| A4 `seat_agent` | `orient` | MCP | brief; open tasks listed | empty list | brief now names `task_board` / `task_list`; else ask the supervisor |
| A5 `want_existing_agent` | `seat_attach { agent }` | MCP | `pending_admission` + `approve_url` (no link when `SECURE_MOMENTS` is off: the note sends the human to the Connections page) | `agent_not_found` (not one the human administers) | human picks an agent they administer; `seat_required` -> do A3a first |
| A6 `awaiting_tap` | give `approve_url` to the human | secure-moment page | "Admitted" page | human has no passkey / no prompt | human adds a passkey at My Account (`/account`) then reopens the link; link expires in 24 h -> call `seat_attach` again |
| A7 `admitted` | `seat_attach` again | MCP | `attached`; next request acts as the agent | `already_pending` (human has not decided) | human decides on the Connections page; a lost link cannot be re-issued while one is live (proposal P5) |
| A8 `attached` | `boot_context` then `orient` | MCP | `identity_receipt.binding_source: attached_seat` | `attached_seat_peek_only` on mail | **planned (#1937)**: attached chat marks its own read mail handled; until then peek only |
| A9 `home` | **planned (S2)** human ticks "Make this the agent's home" | approval page | attachment becomes the host seat | n/a | n/a |

### 2.2 Door B: CLI harness with a bearer token

| State | Single next action | Tool / surface | Success signal | Failure signal | Exact recovery |
|---|---|---|---|---|---|
| B0 `no_token` | Human admin mints the token | dashboard Connect card, or `mint_agent_token` + `reveal_credential_claim` | raw token shown once | `403 forbidden need: admin` | the human must hold admin on the agent's squad; today nothing names who that is (proposal P4) |
| B1 `configured` | Put token in env var, `type: http` config | `.mcp.json` / `config.toml` | `tools/list` answers | `401` bare | one-line token, `type: http`, token minted on THIS pot |
| B2 `first_boot` | `boot_context` | MCP | `onboarding_state: bound` | `unbound_workspace` | token is not agent-bound: admin runs `mint_agent_token` for the agent |
| B3 `bound` | `orient` | MCP | brief | `404 agent_not_found` | wrong token / agent deactivated |
| B4 `declared` | `check_in` with the 7-axis identity; runners add `presence_mode: "poll"` | MCP | seat row | `invalid_args` | fix the enum (instructions item 9) |
| B5 `looking_for_work` | `inbox { peek: true }`, `task_list { assignee_agent_id: <bound_agent_id> }`, `task_board` | MCP | work found | all empty | caught up: tell the supervisor; do not invent work (instructions item 10) |
| B6 `working` | `task_update { status }`; dispatched work also `task_dispatch_runtime_receipt` | MCP | status moves | `task_dispatch_in_flight` etc. | runner playbook |
| B7 `landed` | `task_submit_result { task_id, result }` with `Artifact:` and `SHA256:` | MCP | task in `review` | `400` "a completion result must state both Artifact and SHA256" (`index.ts:3249`) | add both lines |
| B8 `reachable` | install the bridge + Stop hook | `docs/host-a-seat.md` | mail wakes the session | mail only found on poll | one consumer per inbox |

### 2.3 Door C: webhook / bot endpoint

| State | Single next action | Tool / surface | Success signal | Failure signal | Exact recovery |
|---|---|---|---|---|---|
| C0 `no_agent_credential` | do door B state B0 | | | | |
| C1 `peek_routine` | Bot routine peeks `inbox { peek: true }` and `task_list { status: "open" }` | bot platform | routine returns a public HTTPS URL | | |
| C2 `register` | Human admin registers URL + key at `/doorbells` | dashboard, fresh session | doorbell row, last4 shown | `dashboard_only` (bearer) / `webhook_doorbell_disabled` | register in the dashboard; owner sets `WEBHOOK_DOORBELL=1` |
| C3 `test_ping` | "Send test ping" | dashboard | HTTP status displayed | SSRF refusal / timeout | public HTTPS, port 443, no redirects |
| C4 `awake` | Bot peeks, works, settles | MCP over bearer | task settles | `attached_seat_cannot_set_presence_mode` etc. | use the agent-bound bearer, not an attached chat |
| C5 `inbound_rest` | `POST /actions/<tool>` with bearer | REST | `200 ok:true` | HTTP 4xx plain body (no `next_step`) | read the public `/openapi.json`; call `boot_context` first |

---

## 2.4 The `whoami` contract (one answer to "where do I stand")

`boot_context`, `status` and `orient` return the same block, built by `src/mcp/whoami.ts` (`buildWhoami`, pure; the caller supplies the few best-effort reads). The curated profile door omits it (it cannot call the tools the block names).

```
whoami: {
  state: no_agent | own_seat | acting_as | host | harness_unseated,
  basis?: attached | legacy_consent,          // only with acting_as
  have: ["member","harness","seat","agent","keyed","inbox:consume"],
  missing: [{ code, who_acts: self|owner|admin|org_admin, next_step, next_tool?, link? }],
  agent: { keyed, inbox: consume|peek|none|fenced, can_self_report },
  seat?: { seat_id, acts_as, presented },   // acts_as is a slug/name, never an agent id
  harness: present | absent
}
```

| state | connection kinds (door map) | derived from |
|---|---|---|
| `no_agent` | K3 plain directory consent, K2 unbound workspace token, a lapsed consent | no `boundAgentId`, no seat-capable harness |
| `harness_unseated` | K4 OAuth harness grant, K5 harness token | harness pointer or `harnessCredential`, no seat yet |
| `own_seat` | K6 handle or auto seat | `seatBinding`, not attached |
| `acting_as` + `basis: attached` | K7 attached thread | `seatBinding.attached` |
| `acting_as` + `basis: legacy_consent` | K8 consent-bound directory grant | directory + `consentedByMemberId` + bound |
| `host` | K1 keyed or unkeyed agent token | bound, no seat, not directory |

Rules:

- `missing[]` is built from the predicates the tools enforce, so an advertised step cannot be refused for the caller it is shown to. `next_tool` is set only when `who_acts` is `self`; a step another actor takes carries prose and, where one exists, a `link`. A harness token (K5) is only ever pointed at `seat_select`.
- `bootstrap_self` appears in `missing[]` only for an unbound directory session with no harness, no earlier bootstrap, and (no agents in the pot, or the member is an org admin). A stranger in a populated pot is never shown it (#2020). When the lookup fails the mint is not advertised.
- `missing[]` is empty for a seated or keyed session in normal operation. It is not empty for a silent downgrade: `seat_handle_rejected`, `auto_seat_refused`, `attach_refused` and `consent_lapsed` each get an entry with the reason and who acts, and `state` reports the downgraded reality (`own_seat`, not `acting_as`).
- `report_runtime` (boot only, unkeyed host) is the one step that points at `boot_context`; following it changes `registry.outcome` to `recorded`. A keyed agent reports through `POST /api/fleet/attach-signed` and has no missing step for it.
- `next_step`, `onboarding.next_step`, `available_doors` and `channel_limits.to_get_write_access` in `boot_context` are read from `whoami` (first non-report step; the legacy doors filtered to what the connection can call). They remain for compatibility and will be deprecated.
- `orient` with no agent on an unbound session still refuses, and the refusal carries `who_acts`, `next_step`, `next_tool`, `link` and the same `whoami`.
- The consent `link` is the connector's MCP endpoint: removing and re-adding the connector starts the consent screen (there is no HTTP `/connect` page). Under prod flags (`SEAT_ATTACH` off) the tabs are "Me (auto)" and "Existing agent".

## 3. Friction list, ranked by how many agents it blocks

"Blocks" counts distinct new agents stopped. Door A is the dominant population (every ChatGPT/Claude/Grok chat), then door B, then door C.

| # | Friction | Evidence | Blocks | Status |
|---|---|---|---|---|
| 1 | A pot deployed from `wrangler.example.toml` has no chat door: none of `SEAT_AUTO_ENROLL`, `SEAT_ATTACH`, `SECURE_MOMENTS`, `WEBHOOK_DOORBELL` is documented there, so the consent screen offers no "Many chats" and `seat_select` / `seat_attach` are not advertised | `wrangler.example.toml` (no hits for those names); `src/mcp/index.ts:7198-7210` filter | every agent on every new tenant | **Fixed** (commented block in the example) |
| 2 | Nothing the chat reads names `seat_attach` until `channel_limits.to_get_write_access`; the handshake sends it to `bootstrap_self` | `src/mcp/instructions.ts:25`; `index.ts:6377-6414` (bound doors), `6711-6722` | every chat that has an agent | **Fixed** (instructions block + `seat_attach` door in `boot_context`) |
| 3 | `bootstrap_self` from a seat session refuses with copy that offers no next call | `src/mcp/bootstrap.ts:82-88`, `src/members/bootstrap-self.ts:348-349` | every Many-chats chat that follows the handshake | **Fixed** (message names `seat_attach` / `orient`) |
| 4 | Empty `orient` brief: new agent told "ask your supervisor" with no tool, no way to find the supervisor | `src/orient/service.ts:142` | every new agent with no assignment (nearly all) | **Fixed** (names `task_board` / `task_list`); finding the supervisor is P4 |
| 5 | The most common refusal, `forbidden { need }`, carries no next step, on every door | `src/mcp/index.ts:7494`, `mcpToolRefusalResult` 7286 | every agent hits it once | **Fixed** for the MCP envelope; REST `/actions` and the dashboard keep their bodies (P6) |
| 6 | No machine-readable "start here" before credentials: `/`, `/llms.txt`, `/.well-known/mcp.json` redirect to sign-in; unauth initialize is `401`; the instructions are unreachable cold | live reads, section 1.0 | every agent that arrives by URL; every bot | Proposal P2 |
| 7 | First-time approver has no passkey; neither the tool note nor the approval page first screen says to enrol one first | `src/mcp/seat-attach.ts:76-78`; `src/secure-moments/routes.ts:514-526` | every human's first attach | **Fixed in handshake text** (instructions block); page copy is seat-attach/secure-moments surface, listed as P3 |
| 8 | Human must carry a pasted message back to the chat; the agent cannot learn the admission was decided; a re-ask while a link is live returns no link | `src/members/seat-attach.ts:260,280,448` | every attach; worst when the chat lost its context | Proposal P5 |
| 9 | CLI door: "ask an org-admin" names no admin and no channel; `not_agent_bound` is bare | `index.ts:6665`; `docs/playbooks/runner-onboarding.md:21`; `host-a-seat.md` (`not_agent_bound`) | every CLI agent with a member token or without a token | Proposal P4 (**Fixed** the bare `not_agent_bound` envelope text) |
| 10 | Docs disagree with code: events "currently off" (prod: on); add-an-agent omits Many chats / `seat_attach`; harness allowlist omits `worktree_open`; `agent-running-on-mupot.md` is a 2026-06-30 status page | `docs/connect-mcp-client.md:137`; `docs/onboarding/add-an-agent.md:96`; `src/members/harness-credential.ts:28` | every reader | **Fixed** first three; last is P7 |
| 11 | Attached chat sees `inbox_consumer_status: bearer_only` yet `inbox_ack` refuses; the refusal text also names the wrong tool (`inbox_fence_status`) | `index.ts:5403-5408` vs `5079`; `5386` | agents whose only runtime is a chat | mupot #1937 in flight (not touched here) |
| 12 | Bot door: flag-off text addresses the operator; registration is dashboard-only; no bot-side discovery | `src/mcp/webhook-doorbell.ts:88-89,117`; grokbot doc | every bot | Proposal P8 |
| 13 | No chat harness value in `check_in`'s enum, so a chat declares `unknown` | `src/fleet/presence.ts` enum; `docs/onboarding/harness-setups.md` ("no ChatGPT cloud value") | every chat's presence readout | open PR #1903 (graceful labels), not touched here |
| 14 | `orient` rails say "write work to GitHub issues" while the pot's own task tools are the working surface | `src/orient/service.ts:181-190` rails | agents that obey the rails literally | P9 (tenant-neutral wording needs an owner decision) |

---

## 4. What this PR fixed (small and safe, all presentation, no authorisation change)

| Fix | Where | Test |
|---|---|---|
| F1 Document the chat-door flags in the shared example config | `wrangler.example.toml` | `scripts/reserved-bindings.mjs` still clean |
| F2 Handshake names `seat_attach`, the passkey tap, the no-passkey case, and why not `bootstrap_self` from a seat (only while `SEAT_AUTO_ENROLL` and `SEAT_ATTACH` are on) | `src/mcp/instructions.ts` | `tests/onboarding-funnel-teaching.test.ts` |
| F3 Handshake item 10: how to find work (`inbox` peek, `task_list`, `task_board`); item 1 no longer sends an agent-less session to `orient` | `src/mcp/instructions.ts` | same |
| F4 `boot_context` lists `seat_attach` as a door for a seat session that is not yet attached (position 1, after `orient`) | `src/mcp/index.ts` | same |
| F5 `bootstrap_self` and `seat_select` refusals from a seat session name `seat_attach` / `orient` / `boot_context` | `src/mcp/bootstrap.ts`, `src/mcp/seat-select.ts` | same |
| F6 `orient` empty state names `task_board` / `task_list` | `src/orient/service.ts` | same + `tests/orient-service.test.ts` |
| F7 MCP refusal envelope carries `next_step` for exactly five refusal types: (1) `forbidden {need}`, (2) `not_agent_bound` / `agent_bound_credential_required`, (3) `seat_required`, (4) `seat_attach_disabled` / `seat_auto_enroll_disabled`, (5) `rate_limited`. Not covered: `seat_cap_reached`, `agent_not_found`, every other code (their own detail is the text) (static text, never overwrites a refusal that already teaches; REST unchanged) | `src/mcp/refusal-next-step.ts`, `src/mcp/index.ts` | same |
| F8 Doc corrections | `docs/connect-mcp-client.md`, `docs/onboarding/add-an-agent.md`, `src/mcp/instructions.ts` comment | n/a |

## 5. Proposals not built here (sized)

Security-sensitive items are marked **(sec)**: they touch authorisation, credentials, minting or approval and need a gate, not this PR.

| # | Proposal | Size | Notes |
|---|---|---|---|
| P1 | `boot_context.funnel { door, state, next: { tool, args_template }, success, failure }` driven by the state ids in section 2, so every response names the single next action; replaces prose as the contract | M | Additive field; the state table above is the spec. Pin with a test per state |
| P2 | Public static onboarding doc, unauthenticated: `/.well-known/mupot-agent.json` and `/llms.txt` that name the three doors, the MCP URL, how to get a credential, and the docs; reference it from the `401` `www-authenticate` header | M | Static, tenant-neutral (same invariant as `instructions.ts:3-6`); no tenant data. **(sec)** review for the external-facing surface rule |
| P3 | Approval page: show "no passkey yet? add one in My Account first" on the first screen when the approving member has zero passkeys; add the same sentence to `seat_attach`'s `pending_admission` note | S | secure-moments + seat-attach code; held because a separate arm owns seat-attach |
| P4 | `request_access` tool: files a `needs_you` item for the admins who could mint or grant, so "ask an org admin" becomes one call with a human assigned | M **(sec)** | Names admins to the requester: conflicts with the refusal privacy invariant (`src/auth/refusal.ts:23-27`); needs a decision |
| P5 | `seat_attach` returns the live `approve_url` for the same requester on a re-ask (or a `seat_attach_status` read tool); the approval page auto-notifies the pending chat | M **(sec)** | Today `approveUrl: null` is deliberate: a re-minted link rotates and kills the one in the human's hands (`seat-attach.ts:252-256`) |
| P6 | Share the same `next_step` text on REST `/actions` and the dashboard JSON refusals | S | Reuse `refusal-next-step.ts` |
| P7 | Retire or rewrite `docs/agent-running-on-mupot.md` (status 2026-06-30, Discord "replaces dead Telegram") and fold `host-a-seat.md` + `runner-onboarding.md` + `add-an-agent.md` under one index that matches the three doors here | S | Docs only |
| P8 | Bot door: flag-off text names the human owner; an agent-bound bot may request a doorbell and a human approves it with a passkey tap (same shape as `seat_attach`) | L **(sec)** | A doorbell redirects the agent's wake signal; today not delegable |
| P9 | `orient` rails and `emptyWorkLine` read the pot's own task surface, with the GitHub-issues rule only where a GitHub project is bound | S | Tenant-neutral wording; owner decision |
| P10 | Seed a deterministic first task: when a seat agent is created, `orient` shows one `onboarding` task ("introduce yourself via `check_in`, then read `project_context`") so the empty state is never empty | M | Needs an owner on the content |
| P11 | `bootstrap_self` result for a plain directory session also offers `seat_attach` once the session has a seat (the note today says only "reconnect and choose the agent at /oauth/consent", `bootstrap-self.ts:393`) | S | Text in members code |

## 6. How to keep this true

State ids in section 2 are meant to be asserted, not read. P1 turns each row into a test: given a session shape, `boot_context` returns that row's `next`. Until then, `tests/onboarding-funnel-teaching.test.ts` pins the teaching text this PR added so a later change that drops a next step goes red.
