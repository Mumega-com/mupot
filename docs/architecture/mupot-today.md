# What mupot is today

A status table for the surfaces people ask about, with the code or merged PR
behind every row. It is a reading aid, not a roadmap and not a release claim.

**How to read the status column.** It describes the code on `main` at the time
this page was written, judged from `src/`, `migrations/`, and merged PRs. It does
**not** say anything about what production is running (read live `/health`) and it
does not say a feature has been exercised end to end unless the row says so.

| Status | Meaning |
|---|---|
| **works** | Implemented in `src/`; the cited paths exist. |
| **partial** | Implemented, with a known gap named by an open issue or a code comment. |
| **spec** | Described in a doc or comment, no implementation found. |
| **missing** | Looked for it, did not find it. |

This page names no commit, tag, or version on purpose. `git log origin/main`, live
`/health`, and `gh release list` are the authorities; a row that a later merge
changes should be edited in that PR. Line numbers drift; the function or file
names are the durable handle. Where I could not confirm something I say
**not verified**.

Last re-checked 2026-09-30, after #1622 (decision port), #1626 (Access panel),
#1629 and #1633 (MCP Events) merged. Line numbers in `src/mcp/index.ts` and
`src/types.ts` were re-located then.

## Summary

| Area | Status | One line |
|---|---|---|
| Identity and ranks | works, with a known dual-plane wrinkle | 5 ranks on 3 scope types |
| Gates and receipts | partial | gate primitive and append-only verdicts work; "independent" is weaker than it sounds (#1613) |
| MCP door | partial | POST `/mcp`, two auth doors; `tools/list` is unfiltered (#1609) |
| MCP Events (protocol 2026-07-28) | partial: merged, flag off, unproven against a real client | subscriptions, callback verification, signed delivery, receipts; follow-ups #1635 #1636 |
| Decision port | works as a library; no caller | `decide()` is called only by tests; default adapter defers to a human |
| Agent Access panel | works | org-admin control to set an agent's squad access level, with an in-batch receipt |
| Addons framework | partial | manifest v1, install/configure/activate, read+write bindings; two open defects (#1606, #1607) |
| Office publish flow | partial | code path complete; first live publish not exercised end to end (#1617) |
| `task_submit_result` | works, with a gate caveat | assignee-submitted evidence into review (#1613) |
| Channels | partial | Telegram, Discord, Google Chat adapters exist; no Slack or WhatsApp adapter |
| Billing | partial | Stripe checkout/portal/webhook; two webhook events; counts-only enforcement |
| Onboarding | partial / missing | no `/signup` route; one door function has a caller |

## Identity and ranks

| Fact | Status | Source |
|---|---|---|
| Ranks: observer 1 < member 2 < lead 3 < admin 4 < owner 5 | works | `src/auth/capability.ts:188-194` |
| Scope types: `org`, `department`, `squad`; a grant is member × scope → capability | works | `src/types.ts:733`; `migrations/0002_members.sql` (`capabilities`) |
| Capabilities are re-resolved from D1 on every request (revocation is immediate) | works | `src/mcp/oauth-authorize.ts:1164-1167`; described in `docs/connect-mcp-client.md` |
| A member's private `kind='home'` squad is not covered by org, department, or legacy-role authority; only an exact squad grant or a time-boxed elevation reaches it | works | `planeCoversScope`, `src/auth/capability.ts:178`; `canOnSquadAuth` `:555-` |
| Two authority planes exist: capability grants and the legacy `auth.role` owner/admin. Grants-only helpers such as `canOnSquad` cannot see the role plane | partial | comment at `src/auth/capability.ts:521-553`; the OAuth consent picker is grants-only (`src/mcp/oauth-authorize.ts:458-474`, mumega-com#1218) |
| OAuth directory door: unbound seat has zero capabilities; a seat bound to one agent at consent carries that agent's grants clamped to the consenting human's live rank | works | [`docs/connect-from-chatgpt.md`](../connect-from-chatgpt.md) |
| Agents have a dedicated member row (`agent_member_bindings`) and an owning human (`agents.owner_member_id`) | works | `migrations/0155_agent_owner_member_and_origin_verdict.sql:28`; `src/mcp/oauth-authorize.ts:358-364` |

### People and roles

Members hold identity and permission roles only.

- Columns on `members`: `id`, `email`, `display_name`, `telegram_chat_id`,
  `status` (`active` | `suspended`), `created_at`, `tenant`, `telegram_bound_at`,
  and the archive columns (`migrations/0002_members.sql`,
  `0040_members_tenant.sql:22`, `0154_project_invite_member_bind.sql:22`,
  `0173_archive_columns.sql:167-170`; TypeScript shape `Member`,
  `src/types.ts:703-710`).
- What a person may do is the set of capability grants above. There is no
  business-role or profile field (job title, function, responsibilities) on a
  member. I checked the `ALTER TABLE members` statements in `migrations/` and the
  `Member` interface; other tables (login identities, invites) were not audited
  for such a field (**not verified** outside those two places).
- Agents do carry a `role` (e.g. `'member'` at creation,
  `src/mcp/oauth-authorize.ts:1717`); that is the agent's permission role, not a
  business profile either.

## Agent Access panel (#1626)

An org-admin control on the agent page (`/agents/:id`) that sets which squad an
agent sits on and at which access level, or revokes it.

| Fact | Status | Source |
|---|---|---|
| `POST /agents/:id/access` is refused for an agent-bound session (`agent_session_forbidden`) or a non-org-admin (`org_admin_required`) before the agent is even resolved, so a non-admin cannot probe which agents exist | works | `src/dashboard/index.ts:1988-1994` |
| Levels are `observer`, `member`, `lead`, `admin`, never `owner`; there is no default level (an omitted one is refused); a `home` squad is immutable | works | `ACCESS_LEVELS`, `src/dashboard/agent-access-panel.ts:45`; refusals `invalid_capability`, `home_squad_immutable`, `owner_access_untouchable` |
| The change is written through `setAgentSquadAccess` / `removeAgentSquadAccess` (`src/members/agent-access.ts`); this module adds one `INSERT` into `agent_access_receipts` in the same D1 batch, carrying the authority guards as `EXISTS` leaves, and the reported outcome is read back from the receipt row | works | header comment, `src/dashboard/agent-access-panel.ts:1-22` |
| `agent_access_receipts` is append-only (no-update and no-delete triggers); each row records actor, agent, squad, prior capability and membership, new capability, action (`enroll`, `change`, `revoke`), reason | works | `migrations/0187_agent_access_receipts.sql` |
| Migration 0187 applied to production | **not verified** here | the repo cannot show a live D1 state; check with the release operator |
| One test in this area is timing-dependent: `agent-access-panel` "raising and lowering are both changes" orders receipts by `created_at` | partial | open issue #1634 |

This panel is how a human gives an agent the squad access that the OAuth consent
rule in [`connect-from-chatgpt.md`](../connect-from-chatgpt.md) looks at.

## Gates and receipts

| Fact | Status | Source |
|---|---|---|
| A task may carry `gate_owner` (a capability string such as `gate:outreach`); the review → approved/rejected transition requires the caller to hold it via `gate_grants` | works | `migrations/0007_gates.sql` header; `migrations/0008_gate_grants.sql`; `src/tasks/service.ts:17-21` |
| Verdicts are append-only receipts; reversal is a separate receipted path | works | `migrations/0007_gates.sql`; `0118_verdict_reversals.sql`; `0162_task_verdicts_reversal_update_exception.sql`; tools `task_verdict` (`src/mcp/index.ts:2018`), `task_verdict_reverse` |
| Named gate lanes (`gate:athena`, `gate:kasra-core`, `gate:addons`, ...) | works | `src/gates/lanes.ts` |
| A verdict may carry harness-attested human origin (Telegram message) so an agent can carry a human's decision | works (merged) | `5b114bd2` / #1425, `src/im/origin-verdict.ts` |
| Other receipt tables: OAuth consent, dispatch, runtime, execution, membership, pot provisioning | works | `migrations/0091`, `0047`, `0138`, `0123`, `0115`, `0169` |
| "Independent gate" compares agent ids only and ignores `agents.owner_member_id`, so an assignee can pick a sibling agent of the same human as its reviewer | partial | open issue #1613 |

## Decision port (`src/decisions/`, #1622)

A microkernel for small decision models (a classifier or judge) behind one
entry point, so the model can be swapped without touching callers or policy.
Design doc: [`decision-port.md`](./decision-port.md).

| Fact | Status | Source |
|---|---|---|
| `decide(env, request, config)` is the single entry; no type in the port carries an authorize or allow field: a model output is data, never a permission | works | `src/decisions/decide.ts:211`; `src/decisions/port.ts`; `tests/decisions-port.test.ts` |
| **Nothing in `src/` outside `src/decisions/` imports `decide()`.** Only tests call it. (`src/loops/decisions` is an unrelated module with a similar name.) | works, unused | grep of `src/` for imports of `decisions/decide` and `decisions/registry` |
| Default adapter is `human` (always `deferred_to_human`, sends nothing); `DECISION_ADAPTER` may select `workers-ai` or `typesafe`; an unknown value falls back to `human` | works | `selectAdapter`, `src/decisions/registry.ts:9-19`; `src/types.ts:336-339` |
| One `decision_receipts` row per call, success or failure; raw input is never stored (hashes only); no-update and no-delete triggers | works | `migrations/0189_decision_receipts.sql:37-47`; `docs/architecture/decision-port.md` |
| `decision_outcomes` (a human's later accept or override) exists as an append-only table; no code writes it yet | partial | `migrations/0189_decision_receipts.sql:49-74`; `docs/architecture/decision-port.md` |
| Migration 0189 applied to production | **verified 2026-09-30** | remote D1 `sqlite_master` read: `decision_requests`, `decision_outcomes`, `decision_receipts`, `decision_request_resolutions` and their append-only/transition triggers exist |
| Known gaps to close before the first caller or reader: `INSERT OR REPLACE` can rewrite a receipt, a `choice` answer is not required to match the top probability, `tenant` is nullable | partial | open issue #1635 |

Because there is no caller, none of those gaps is reachable from production
today; the issue says they must land before one is wired.

## The MCP door

| Fact | Status | Source |
|---|---|---|
| `POST /mcp`, JSON-RPC 2.0; methods `initialize`, `notifications/initialized`, `tools/list`, `tools/call`; plus `server/discover` and `events/*` only when `EVENTS_ENABLED` is exactly `"true"` (see [MCP Events](#mcp-events-protocol-2026-07-28)) | works | `handleJsonRpc`, `src/mcp/index.ts:6425-6561` |
| `initialize` reports `protocolVersion: '2025-06-18'` unless the flag is on **and** the client explicitly asks for `2026-07-28`; every other request takes the legacy branch | works | `src/mcp/index.ts:6440-6457`; `negotiateProtocolVersion`, `src/mcp/events.ts:19-22, 41-47` |
| Two auth doors: `mupot_…` member bearer, and OAuth 2.1 (DCR, PKCE S256, refresh) | works | `docs/connect-mcp-client.md`; `src/index.ts:266-295` |
| `tools/list` returns the whole registry (143 tools, measured by `scripts/check-openapi-public-allowlist.mjs` when this page was updated; #1609's title and older docs still say 144) to any valid token, regardless of capability | partial | `src/mcp/index.ts:6472`; open issue #1609 |
| Public `GET /openapi.json` is an explicit allowlist; `/openapi.full.json` is org-admin gated but admits agent-bound org-admin bearers | partial | #1603 (merged); open issue #1608; `scripts/check-openapi-public-allowlist.mjs` |
| Curated read-only door `POST /mcp/profile/needs-you`: same auth as `/mcp`, `tools/list` only for an authenticated caller and only the allowlist, `tools/call` outside it refused `tool_not_in_profile` | works | `src/mcp/index.ts:6464-6471, 6485-6487`; `src/mcp/profile-needs-you.ts`; [`connect-chatgpt-needs-you-profile.md`](../connect-chatgpt-needs-you-profile.md); #1624 |
| MCP server-to-client events (protocol 2026-07-28) so a subscribed chat is notified of inbox messages | partial: merged, **off**, unproven against a real client | [MCP Events](#mcp-events-protocol-2026-07-28) below; open spike #1618 |
| Bridge-based receive for hosted seats | works | [`docs/host-a-seat.md`](../host-a-seat.md) |

## MCP Events (protocol 2026-07-28)

So a subscribed client (ChatGPT) can be told when an agent's inbox gets a message.
Merged in two PRs: #1629 (negotiation, `server/discover`, `events/list`) and #1633
(subscribe, unsubscribe, callback verification, signed delivery, receipts). Design,
limits and refusal codes: [`mcp-events.md`](./mcp-events.md).

**Everything is behind `EVENTS_ENABLED`, which is on only for the exact string
`"true"`** (`isEventsEnabled`, `src/mcp/events.ts:30-33`). Per the release
operator it is off in production and `EVENTS_CALLBACK_HOSTS` is unset; I could not
confirm either from outside, because `/mcp` refuses an unauthenticated probe
(**not verified** here).

| Fact | Status | Source |
|---|---|---|
| Flag off or anything but `"true"`: `initialize` keeps the legacy version, `server/discover` and `events/*` fall through to `method_not_found` before any auth or DB work, and the queue consumer never calls the fan-out hook | works | `src/mcp/index.ts:6438, 6440-6457, 6520, 6561`; `src/bus/consumer.ts:605`; `src/bus/events-delivery.ts:55, 163` |
| Events are served only on the full `/mcp` door, never on `/mcp/profile/needs-you` | works | `src/mcp/index.ts:6438` |
| One event exists, `message.created` (the bound agent's own inbox, body-free payload); any other name is refused `unknown_event` | works | `src/mcp/events.ts:94`; `docs/architecture/mcp-events.md` |
| `events/subscribe` needs a bound, active agent session; the subscription id includes the principal; TTL 5 min to 24 h (default 1 h); 10 active subscriptions per agent; 5 verification attempts per agent per 10 minutes | works | `src/mcp/events-subscriptions.ts:20-28, 164`; `TTL_*` constants |
| The callback URL must be HTTPS and its hostname must exactly match an entry of `EVENTS_CALLBACK_HOSTS`; **the default (empty) refuses every URL** | works | `validateCallbackUrl`, `src/mcp/events-webhook.ts:54-76`; `src/types.ts:329` |
| Before a subscription is stored, a signed challenge is POSTed to the callback and must be echoed; all outbound requests use `redirect: 'manual'` and a 10 s timeout | works | `verifyCallback`, `src/mcp/events-webhook.ts:254`; `postSigned` `:193-210`; `CALLBACK_TIMEOUT_MS` `:19` |
| The signing secret is stored only as vault ciphertext (domain `mcp_events`); subscribing fails closed if `CONNECTOR_MASTER_KEY` is unset | works | `src/mcp/events-subscriptions.ts`; `src/connectors/crypto.ts`; `docs/architecture/mcp-events.md` |
| Delivery: the consumer's `message.created` case enqueues one `mcp.event.delivery` job per active subscription; the job carries `{job_id?, subscription_id, message_id}` and everything authoritative is re-derived from D1 at delivery (`job_id` is informational); up to 5 attempts with exponential backoff; one append-only receipt per attempt | works | `src/bus/events-delivery.ts:27-48, 54-92, 303-311`; `migrations/0188_mcp_event_subscriptions.sql:57, 86-92` |
| Per-subscription cap of 30 new events per minute; the excess gets a terminal `refused` receipt | partial | `MAX_DELIVERIES_PER_MINUTE`, `src/bus/events-delivery.ts:31, 235`; open issue #1636 |
| Migration 0188 applied to production | **verified 2026-09-30** | remote D1 `sqlite_master` read: `event_subscriptions`, `event_verification_attempts`, `event_delivery_receipts` and `event_delivery_receipts_no_update`/`_no_delete` triggers exist |
| **A real ChatGPT client, or the Workers runtime, completing the subscribe, verify, deliver loop** | **not proven** | the tests use the node SQLite D1 harness and a stubbed `fetch`; `redirect: 'manual'` on `workerd` and DNS rebinding (the allowlist is the mitigation) are noted as unverified in `docs/architecture/mcp-events.md` |
| Known gaps: flood-induced event loss, `INSERT OR REPLACE` on the append-only receipts, unbounded table growth | partial | open issue #1636 |

The design doc also states that the callback-validation design still needs Hadi's
acceptance before the flag or `EVENTS_CALLBACK_HOSTS` is set anywhere.

## Addons framework

| Fact | Status | Source |
|---|---|---|
| Manifest schema `mupot.addon/v1`; `kind: 'native' \| 'external_mcp'`; `trustClass: 'native_reviewed' \| 'external_isolated'`; a native kind must be `native_reviewed` | works | `src/addons/contract.ts:3-11, 405-406` |
| Installation rows carry `isolation_class` | works | `src/addons/service.ts:341, 371`; `migrations/0175_addon_external_isolated.sql` |
| Lifecycle tools: `addon_install`, `addon_configure`, `addon_activate`, `addon_disable`, `addon_archive`, each org-admin | works | `src/mcp/addons.ts:172, 187, 232, 251, 266` |
| Connector bindings carry capability `read` or `write` (column `capability_v2`, migration 0184) | works | `src/addons/bindings.ts:64-68, 141`; #1614 |
| A `write` binding is honoured only when the manifest is `external_mcp` + `external_isolated`, the live installation is `external_isolated`, and the manifest passes the external-isolation invariants | works | `installationMayHoldWriteCapabilityBinding`, `src/addons/bindings.ts:344-350` |
| Only one manifest declaring a `write` connector requirement is in the repo: `mcpwp-office` | works | `src/addons/office/manifest.ts:42-74` (no native manifest declares one, comment `src/addons/bindings.ts:320`) |
| `marketing-cro-monitor` binding generation split from installation identity since migration 0089; the monitor is likely failing | partial | open issue #1606 |
| Receipts and monitor-run history carry digest copies, so pre-backfill disabled rows hit `fence_lost` and history is hidden | partial | open issue #1607 |

## Office publish flow (mcpwp-office)

Publishing a task's content to a WordPress site through a write-capable
connector binding. Tools (`src/mcp/office.ts`): `office.publish_post`,
`office.list_pending_approvals`, `office.review_approval`,
`office.reconcile_stalled_publish`.

| Step or rule | Status | Source |
|---|---|---|
| **Freeze at review.** Entering `review` on a `gate:office` task freezes title + body and records `payload_sha256` | works | `freezeOfficeTaskOnReviewEntry`, `src/addons/office/freeze.ts:365`; table `office_publish_freezes` |
| **Approval names the payload.** An `approved` verdict must echo `expected_payload_sha256`; refusals `expected_hash_required`, `payload_mismatch`, `payload_stale` | works | `reviewOfficeApproval`, `src/addons/office/service.ts:219-238, 320`; `freeze.ts` refusal list; #1602, #1592 |
| **Re-verify inside the write.** The verdict batch's `WHERE` re-checks the freeze row (unvoided, unbound, hash matches) and that the live task title/body still equal the frozen payload | works | `src/addons/office/service.ts:386-470` |
| **Atomic one-shot claim.** `UPDATE ... SET claimed_by, claimed_at, idempotency_key = COALESCE(...) WHERE ... claimed_at IS NULL RETURNING`; no row means `publish_claimed`, no fetch | works | `src/addons/office/service.ts:924-983` |
| **Idempotency key.** Migration 0185 adds `idempotency_key`; it is stamped into the WordPress post `slug` | works | `migrations/0185_office_publish_freeze_idempotency_key.sql`; `service.ts:93-100, 986` |
| **Outcome classification.** `delivered` (parsed 2xx), `definite_failure` (with a refusal reason), else `ambiguous`; ambiguous leaves `outcome` NULL and the row claimed | works | `src/addons/office/service.ts:532-575, 644-654, 999-1003` |
| **Reconcile never infers absence.** Two outcomes only: `reconcile_candidate_found` (any evidence, never overridable) and `reconcile_check_unavailable` (no answer or clean empty; the only case a human override may accept, after a retry) | works | `src/addons/office/service.ts:658-690`; `OfficeRefusalReason` in `freeze.ts` |
| A claimed-but-unreconciled prior freeze blocks a new review-entry freeze | works | `unreconciledPriorFreezeExists`, `freeze.ts:237` |
| Freeze lock stays locked after the task leaves the office flow; reason reversal refused; title guard untested | partial | open issue #1612 |
| Reconcile does not persist candidate evidence across calls; no accept-as-done path; no MCPWP post-meta idempotency marker | partial | open issue #1615 |
| The MCPWP connector should authenticate with an MCPWP API key and use post meta as the idempotency key | partial | open issue #1616 |
| First live publish exercised end to end; acceptance test and test-site cleanup | not done | open issue #1617 |

## `task_submit_result`

| Fact | Status | Source |
|---|---|---|
| The agent assignee of a hand-worked, never-dispatched task reports `result` (must state `Artifact: <path>` and `SHA256: <64-hex>`, a shape check only) and enters `review` in one step | works | `src/mcp/index.ts:2572-2580` (spec); #1600 |
| Receipt row and status flip land in one `DB.batch`; table `task_result_submissions` | works | `migrations/0183_task_result_submissions.sql`; #1600 |
| The task must already carry an independent gate; the tool never accepts `gate_owner` | works, but see #1613 | `src/mcp/index.ts:2658-2663`; the "independent" predicate is the one #1613 says is too weak |
| After a rejection, the assignee can move the task back to review with the rejected result still on the row, no fresh receipt | partial | open issue #1613 (P2) |
| Human-held gates (`gate:hadi`) cannot use it | partial | open issue #1613 (P3) |

## Channels

| Fact | Status | Source |
|---|---|---|
| Channel adapter registry has exactly three adapters: `discord`, `google-chat`, `telegram` | works | `src/channels/registry.ts:14-25`; `src/channels/adapters/` |
| Telegram: adapter, `/im/webhook`, governed project onboarding, bind-to-existing-member, harness-attested verdicts | works (merged) | `src/channels/adapters/telegram.ts`; `src/im/index.ts`; #1407 `49a344aa`, #1411 `fdf51fa8`, #1425 `5b114bd2` |
| Discord and Google Chat adapters | exist; live use **not verified** | `src/channels/adapters/discord.ts`, `google-chat.ts` |
| Slack or WhatsApp inbound/conversational adapter | missing | not in `src/channels/registry.ts`; `src/billing/plans.ts:54,68` mentions WhatsApp only as a plan-feature label with no adapter behind it |
| Outbound alert webhooks (`generic`, `slack`, `discord` payload formats) | works | `src/alerts/dispatcher.ts:6, 52, 124`; this is notification delivery, separate from channel adapters |

## Billing

| Fact | Status | Source |
|---|---|---|
| Routes: `GET /status` (member), `POST /checkout` (org admin, CSRF), `POST /portal` (org admin, CSRF), `POST /webhook`; mounted at `/api/billing` and `/webhooks/stripe` | works | `src/billing/routes.ts:31, 53, 87, 106`; `src/index.ts:134-135` |
| Webhook fails closed: 503 without `STRIPE_WEBHOOK_SECRET`, 401 on bad signature | works | `src/billing/routes.ts:106-135` |
| Webhook handles only `checkout.session.completed` (upgrade, this tenant only) and `customer.subscription.deleted` (downgrade to `free` if it matches the stored subscription); every other event type returns `ignored_event_type` | works | `src/billing/stripe.ts:236, 275, 302-304` |
| Tiers `free`, `starter`, `pro`, `scale`; limits are documented in code as scaffolding defaults | works | `src/billing/plans.ts:48-107` |
| Enforcement is on counts only: departments, squads, agents | works | `checkCreateLimit`, `src/org/service.ts:127, 244, 867`; `src/departments/registry.ts:415`; `src/reseller/provision.ts:247` |
| `monthlyModelBudgetMicroUsd` is defined and displayed; I found no enforcing caller | partial | `src/billing/plans.ts:99-106`; `src/dashboard/billing.ts:162` (grep over `src/`, **not verified** beyond that) |
| Feature entitlements (`byo_model`, `sso`, `audit_export`, ...) are defined; `potEntitled` has no caller outside `src/billing/entitlement.ts` | partial | `src/billing/plans.ts:50-70`; `src/billing/entitlement.ts:59` |
| Anonymous self-serve pot checkout `POST /api/pots/checkout` is off unless `POT_SELF_SERVE_CHECKOUT_ENABLED` is exactly `"true"` | works (default off) | `src/pots/routes.ts:138-144`; `src/types.ts:316-320`; #1543 |

## Onboarding

| Fact | Status | Source |
|---|---|---|
| No `/signup` route. The only occurrence in `src/` is an `href` in an HTML string | missing | `src/dispatcher.ts:288`; grep for `signup` over `src/` finds no route handler |
| `handlePotCreationCompleted` (self-serve pot creation after Stripe checkout) has no caller in `src/`; only tests call it. The webhook does not dispatch to it | missing | defined `src/pots/checkout.ts:104`; called only from `tests/pot-checkout-provisioning.test.ts`; webhook cases `src/billing/stripe.ts:236, 275` |
| `src/onboarding/doors.ts` door functions (`openDoor`, `getOpenDoor`, `selfGrant`, `closeDoor`, `listPendingReceipts`, `applyDisposition`, `crystallizeDoor`) have no caller in `src/` outside that file | missing | grep over `src/` |
| The one exception: `grantSignupDefault` is called when a human member is created from a verified login | works | `src/members/human-identity.ts:86-87` (dynamic import, failure non-fatal) |
| Google sign-in creates a `members` row at first callback; the consent screen offers "Name your first agent" (`bootstrapSelf`) to a human with no agents and no administered squad | works | `src/mcp/oauth-authorize.ts:714-720, 1616-1686` |
| First agent via the `bootstrap_self` tool | works | `src/members/bootstrap-self.ts` |

## Known open issues referenced above

All open when this page was written (checked with `gh issue view`; re-check
before relying on it).

| # | Title (abridged) | Area |
|---|---|---|
| #1605 | SSRF: block remaining IPv4-in-IPv6 embeddings and non-global v6 ranges | security |
| #1606 | `marketing-cro-monitor` binding generation split from installation identity since 0089 | addons |
| #1607 | Addon identity backfills: receipts and monitor-run history carry digest copies | addons |
| #1608 | `openapi.full.json` admits agent-bound org-admin bearers | MCP door |
| #1609 | `tools/list` returns all tools to any token; tighten openapi ratchet; fix docs/CHANGELOG claim | MCP door |
| #1612 | Office freeze lock stays locked after the task leaves the office flow | office |
| #1613 | Task gates: "independent" ignores shared owner; stale result re-enters review | gates |
| #1615 | Office reconcile: persist candidate evidence; accept-as-done path; post-meta marker | office |
| #1616 | Office: MCPWP connector auth via API key; post meta as idempotency key | office |
| #1617 | Office: first live publish not yet exercised end to end | office |
| #1618 | Spike: MCP Events so a subscribed ChatGPT chat is notified of inbox messages (PR 1 and PR 2 merged, flag off) | MCP door |
| #1634 | Flaky test: agent-access-panel orders receipts by `created_at` | access panel |
| #1635 | Decision port (#1622) P2/P3 follow-ups | decision port |
| #1636 | MCP Events PR2 (#1633) follow-ups | MCP Events |

## What I did not check

- Production behavior of any row (only `src/`, `migrations/`, and merged PRs).
- Test coverage of any row.
- Whether Discord and Google Chat adapters are wired to a live deployment.
- Tables and columns outside the migrations and files named in the Source column.
