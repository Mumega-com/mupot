# Integration contracts and compatibility

[Master](MASTER.md) · [Architecture](ARCHITECTURE.md) · [Decisions](DECISIONS_AND_FEEDBACK.md)

Status: implemented 0.1.0 wire behavior plus explicitly separate dependency/proposed contracts. This document does not make a server operation available to every client or authorize its use.

## 1. Current Rust → Mupot HTTP surface

The app uses fixed HTTP endpoints through client.rs (`host/mumachine/src/client.rs`, local source reference), not a generic arbitrary-tool runner. Its user-facing Mupot address is a plain HTTPS origin. The app's browser-approved device credential is separate from an existing desktop harness's OAuth connection.

| Operation | Method/path | Request | Validation/result |
| --- | --- | --- | --- |
| Public health | `GET /health` | No credential | `ok`, service `mupot`, nonempty tenant; health is not login |
| Begin device approval | `POST /device/code` | JSON `agent` = exact desired UUID | Challenge code, user code, same-origin `/device` URI, bounded TTL/interval |
| Poll approval | `POST /device/token` | JSON `device_code`, secret staging buffer | Handle pending/slow-down/denied/expired; only a successful HTTP status can yield a credential |
| Verify boot | `POST /actions/boot_context` | App credential; source/seat metadata currently sent | Minted identity, exact tenant and bound agent must agree |
| Load orientation | `POST /actions/orient` | App credential; empty argument object | Returned agent ID and slug must agree with the verified connection |
| Explicit app presence | `POST /actions/check_in` | App credential; source `mumachine`, seat `mupot-connect`, harness `unknown` | Revalidate first; returned agent ID and seat must match |

Authenticated calls use an Authorization header and the descriptive `x-mupot-source` / `x-mupot-seat` headers. These descriptors are not permission or runtime proof. The current Rust client does not call inbox, send, lease, runtime-receipt, agent-creation, grant, deployment, or generic host-control endpoints.

### Actual request and storage constraints

- Connection timeout: 5 seconds; whole request timeout: 15 seconds; redirects disabled; system proxy configuration is not used by this client.
- Maximum response body: 1,048,576 bytes, enforced both from declared length and actual reads.
- Agent UUID input: lowercase hexadecimal UUID text with the standard hyphen positions, 36 characters. Tenant/slug-style identifiers are nonempty, at most 128 bytes, ASCII alphanumeric plus `-`, `_`, `.`.
- Challenge lifetime: positive and at most 3,600 seconds. Poll interval: positive and at most 300 seconds. Returned credential lifetime: positive and at most 604,800 seconds, conservatively bounded against challenge start.
- The app may present the short approval code to the user; the device code and credential must not appear in ordinary output or profiles.
- Actions responses require `ok: true` and a `result`. HTTP success is not enough if the application response refuses the operation.

The exact source, fixture tests, and [security document](SECURITY_AND_PRIVACY.md) control edge cases. Server-schema compatibility and real enrollment remain a dedicated verification, not an assumption from a mock response.

## 2. Human OAuth and host identity

Existing Mupot OAuth legitimately authenticates its caller. The planned user journey should reuse that human-led entrance and authorized existing agents. It must not require harvesting the favorite harness's private OAuth token.

Current app device approval, a shared desktop connector OAuth grant, seven-axis check-in, `agent_sessions`, and a signed fleet attachment are different contracts. The existing app's one selected verified credential does not automatically map many desktop conversations to many agents.

Kasra identified existing boot, key/binding attestation, signed attach and runtime-seat registration primitives for reuse. Dara identified effective seat maps, stream ownership and host event behavior. Which combination proves a desktop operator is **D-001**, not a new hard-coded contract in this documentation.

Important product constraint: an existing login is not treated as absent. Important security constraint: choosing a display label or passing a UUID is not sufficient to authorize a different identity or inbox.

## 3. Herdr and seatlink

### Current app discovery

The app locates an executable Herdr binary, invokes `herdr agent list`, and validates a bounded JSON response containing `result.type = agent_list` and `result.agents`. It retains name, agent kind and state. It does not retain a desktop route or authenticate a Mupot participant through that name.

### Existing seatlink, separate from Rust

The inspected Mac seatlink uses Herdr topology and per-pane subscriptions, a live seat map, Mupot inbox SSE, busy/blocked deferral, and exact Herdr prompting. The remote notification carries identifiers so the agent can read and handle its own Mupot inbox. Local sentinel messaging is a separate path. Notification, consumption and response must not be conflated.

As observed September 10, launchd owned Mac `--serve`; the effective manifest had no `[[startup]]`. Registry and README metadata were stale in places. The VPS 0.3.1 installation was reported as separate. Confirm effective source, service command, state and consumer ownership on each host before any intervention.

The older installed bridge remains a separate implementation. Its startup board/reporting loops do not automatically deliver inbox messages, while its manual delivery action can compete with seatlink. Do not enable it as an integration shortcut.

### Proposed Rust handoff

No agreed local ingress-to-Rust handoff API exists in this documentation. **D-002/D-003** must define:

- The authoritative receiver and the exact identity/route it owns.
- How Rust is authenticated as the local recipient of a handoff.
- Correlation, version, destination, assignment, expiry and replay/ownership evidence.
- Which component persists pending responsibility before acknowledging the handoff.
- Busy, blocked, offline, unsupported and uncertain-delivery responses.
- How runtime consumption, result and control acknowledgments return.

These are required contract questions, not fields in a newly released schema. Basic loss prevention is required before any live 0.2 exchange: if the existing durable owner cannot safely retain responsibility, the required durability work becomes a 0.2 prerequisite. The 0.3 milestone expands resilience; it does not permit a lossy 0.2 handoff.

Herdr's `agent.prompt` is not automatically a Codex Desktop conversation API. The desktop adapter must bridge that final boundary explicitly and must not assume the desktop app is a Herdr pane.

## 4. Existing Mupot runtime dispatch and return-work contract

Read the existing [runtime dispatch operations](../../../docs/operations/runtime-dispatch-v1.md). It describes a server-generated `runtime.dispatch/v1` body with task, dispatch receipt, squad and public runtime address. Private desktop conversation identifiers remain local; body metadata must agree with the authenticated outer message.

The documented native stages are `runtime_consumed`, `completed`, and `failed`, with idempotency and terminal fencing. Receipt creation requires the appropriate current assignee, message, attempt, route, project and lease authority. A completion normally enters review, not production publication.

This is existing server work, not an implemented Rust API call. The exact callable schema and enabled client policy must be checked at integration time. Keep ordinary task dispatch distinct from the stronger Flight-3 signing/assignment contract.

The September 10 review identified dispatch and artifact/result-gate work in #1388, #1390, #1394 and #1395. Pin the reviewed outcomes before the host relies on them. In particular, an unavailable external operator must not silently cause another execution environment to perform the work under that identity.

## 5. Codex and other desktop harnesses

The [existing Codex receiver status document](../../../docs/operations/codex-exact-delivery-status.md) distinguishes active-turn MCP access, a standalone exact receiver, and activation proof. It is a dated reference, not permission to duplicate or activate another receiver.

Official Codex App Server documentation includes thread/turn lifecycle and account usage/rate-limit interfaces. The account section was checked on September 10: `account/rateLimits/read`, `account/rateLimits/updated`, and `account/usage/read` are documented. This is not evidence that the Rust app can currently connect to the owning desktop instance. See [official documentation](https://learn.chatgpt.com/docs/app-server).

For each adapter, record the exact installed version, transport, supported operations, permissions, test receipt, and degraded behavior. Keep private/experimental desktop integration experiments out of supported release claims until independently reviewed and version-gated. Do not scrape a private credential store or impersonate the desktop's own internal client.

The same product role can later be supported by Cursor, Claude, Grok or another desktop harness, but each needs its own verified adapter. A CLI hook or headless API does not establish control of an ordinary desktop conversation. An existing cloud pager is a different delivery mode; retain that distinction in the UI and support matrix.

## 6. Usage, availability and recovery signals

Each planned observation needs its origin, collection time, applicable scope, and freshness policy. Distinguish:

| Signal | Meaning | Invalid substitute |
| --- | --- | --- |
| App/version | Observed installed or running build | Cached plugin registry version presented as loaded code |
| Model | Provider/harness-reported current model | A fixed lookup from app brand |
| Context use | Current context consumption/headroom when exposed | Account subscription quota |
| Per-turn usage | Reported input/output/cache token activity | Scrollback character estimates labeled measured tokens |
| Account limit | Provider-reported quota window/usage/reset | Per-agent budget or nominal token price |
| Availability | Observed ability of the intended session to accept work | Authentication success or process existence alone |

The host may recommend waiting or an authorized continuation when a dependency fails. It must not automatically spend, consume account-reset credits, change providers, grant access, or reassign a writer without the agreed policy. Pending effects require reconciliation before another agent retries them.

## 7. Existing web and Mubot interfaces

Mupot web, Co-Pilot, Studio, project views, Needs You, and approvals remain existing product interfaces. Planned Rust reporting should feed their canonical services; it must not create a second task/review authority.

Mubot should reuse the existing channel gateway and verified sender-to-member linkage. Group/chat/topic routing is not authorization. Review links/actions must use current artifact/version and canonical verdict checks; do not adopt legacy IM privilege shortcuts as a new approval contract. This app version does not install or configure a bot.

## 8. Compatibility record required per integration

For every supported deployment, retain app version/build/hash, server commit/schema/feature flags, plugin version and effective source, harness build and adapter revision, host identity, route owner, last conformance receipt, and rollback compatibility. Never include secrets or private chat bodies in that record.

Cross-version support is **unknown until tested**. A numeric version comparison cannot replace protocol and lifecycle compatibility proof.
