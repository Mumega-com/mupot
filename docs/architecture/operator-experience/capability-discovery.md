# Capability Discovery: one catalog, distinct surfaces

## Decision

Mupot has a large capability surface: static source inventory found 284 HTTP route definitions and 117 registered MCP tools. These counts are not a public API count: routes can be mounted, aliased, provider-signed, internal or host-policy gated; an MCP tool can be registered yet disabled for a client or unauthorized for a caller.

Create one versioned **capability catalog** that describes existing capabilities, then project it to operator UI and MCP clients. The catalog does not execute an action and does not become a second authorization engine.

## Intent-first discovery

Present capabilities by operator intent:

1. Connect an agent
2. Organize people, agents and squads
3. Onboard a project
4. Create and observe work
5. Review evidence
6. Recover from interruption
7. Automate governed work
8. Administer integrations and the pot

The initial human view should be small and relevant. Search and context reveal specialized capabilities only when the caller can discover them safely.

Internal harness primitives—delivery leases, acknowledgements, seat fencing, runner records and provider callbacks—remain internal. Their receipts and freshness should be readable from work, review and operations surfaces.

## Catalog contract

Every capability needs a stable ID, title, concise intent description, risk, lifecycle status, aliases/deprecation metadata, related journey and links to its distinct HTTP operations, MCP tools, UI controls and backing service.

Availability has independent dimensions:

| Dimension | Meaning |
|---|---|
| Registered | A source declaration exists. |
| Host enabled | The current host/client policy includes it. |
| Authorized | The server would permit this caller and scope. |
| Runtime available | A required harness/provider is reachable, when relevant. |
| Test evidence | Fixture, controlled canary, live receipt, source-only, or unknown. |
| Lifecycle | Active, compatibility alias, deprecated, experimental or internal. |

Do not turn any of these fields into authorization. Existing route and tool guards remain canonical.

## First product pilots

### Connect an existing agent

The current journey spans Agents, People & Access, Enroll, Tokens, Connectors and Verifications. The guided flow should select an existing canonical agent, explain eligibility, resolve membership/capability prerequisites, reuse or issue a scoped credential only when authorized, bind the harness and show a check-in receipt. It must never silently create a duplicate identity.

### Manage memberships

Expose existing-agent membership from both Agent and Squad detail. Show current memberships, effective capability, scope impact and a safe add/remove action. Credential issuance is not part of this action.

### Evidence timeline

Project/work/flight detail should show dispatch, delivery, runtime consumption, result, verdict and deployment as separate receipt states. This offers useful operator visibility without exposing raw lease or ACK controls.

## Source and rollout

Generate catalog entries from typed MCP declarations, route operation IDs, dashboard control mappings and a test-evidence registry. Generate docs and caller-filtered read-only catalog views from that same source. Add capability IDs first, then discovery API/docs, then the two UI pilots, then optional host-specific progressive MCP exposure.

Use aliases and deprecation telemetry before removing a name or route. Do not merge tools merely to reduce a count: evaluate intent, authorization and compatibility separately.

## Acceptance checks

- A UI control maps to an active catalog capability.
- Discovery does not reveal hidden agents, credentials, projects or internal primitives.
- A directory OAuth caller can see why a capability is unavailable without receiving standing write authority.
- Connection and membership recovery preserve context and create no duplicate identity or token.
- Host policy tests prove a disabled registered tool is not callable; server authorization still guards an enabled tool.

For MCP client behavior, consult current host documentation: server-provided tools and `instructions` are distinct from client enablement and per-tool approval policy. Do not assume a client-specific grouping or search behavior is protocol-enforced.
