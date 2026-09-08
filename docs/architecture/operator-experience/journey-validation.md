# Operator Journey Validation and UX Findings

## Method

The product audit used current source definitions, isolated local fixtures and read-only owner browser observation. It did not create production agents, tasks, credentials, permissions, messages, gate verdicts, purchases or deploys.

Evidence grades are independent:

- **Fixture pass:** isolated test proves a contract.
- **Live observed:** a signed-in owner browser rendered a read-only page.
- **Source-only:** implementation was inspected but not executed.
- **Unknown:** no sufficient evidence. This is not failure or green.

## Validated journeys

| Journey | Evidence | Important limit |
|---|---|---|
| Create/reuse agent and cross-squad membership | Isolated organization, membership and dashboard fixtures. | UI discoverability remains weak. |
| Credential, enrollment and check-in | Connection, OAuth consent, token, check-in and seat fixtures. | Production owner enrollment had no eligible agent. |
| Project setup | Dashboard, lifecycle, start-gate and route fixtures. | Not every role/browser state was exercised. |
| Backlog, dispatch, runtime receipt and gate | Dispatch, lease, lifecycle, gate and artifact fixtures. | No production dispatch or verdict. |
| Routines, loops, recovery and memory | Routine, loop, project-memory, adapter and receipt fixtures. | No production scheduler/canary. |
| Branch, PR and deployment boundaries | CI/staleness/release fixtures and read-only deployment page. | Branch protection and reviewer policy need GitHub admin evidence. |

## Findings

### 1. Enrollment is a recovery dead end

The owner-facing enroll page correctly requires an active, identity-bound agent and appropriate squad authority, and advises key reuse before minting. When no agent is eligible it offers only generic recovery wording. Show the actual blocking condition, eligible targets after the right grant, authorized grantor and a return path preserving the selected seat.

### 2. Existing membership is implemented but hard to find

Backend and MCP support adding an existing agent to another squad. The UI makes creation/token paths more prominent than this reuse path. Surface membership management from Agent and Squad detail and preview impact before a change.

### 3. Agent directory overloads routine and destructive actions

The owner directory combines objectives, budgets, current work, configuration, pause and delete on a long card list. Separate identity/runtime browsing from configuration; make destructive lifecycle action a deliberate recovery-aware panel. Show canonical ID, home squad, seat/harness and freshness.

### 4. Work mode separation is good; gate selection is not

The work page explicitly distinguishes a backlog-only task from live dispatch. Its independent gate owner is a free-text field. Replace it with a server-resolved eligible-gate picker and clear fallback to draft/backlog.

### 5. Operational truth needs one shared taxonomy

Home, Agents, Mission Control and Operations each expose partial liveness. Distinguish configured identity, attachment, heartbeat freshness, reported lifecycle, verified execution, result, verdict and deployment. Do not group an unattached catalog identity with a stale runtime.

### 6. Approval evidence is too raw

Approvals and Home can render long historical bodies with many decision controls. Make Approvals the canonical paginated action surface; lead with result/version/gate/freshness and open supporting evidence on demand. Needs You remains a cross-source attention queue, not another approval implementation.

## Required next validation

Use a disposable staging tenant for real owner/member eligibility and safe key reuse UI tests. Use a controlled non-production harness canary for receive → consume → ACK → artifact → independent verdict. Do not treat source tests as a production receipt.
