# 0002 — Reachability, not agent-identity, is the authz test

**Status:** accepted
**Date:** 2026-08-09
**Decided by:** Hadi (principal). Accepted by River, who will rule on this basis going forward.

## Decision

When gating a capability, the question is **not** *"should an agent be able to do this?"* It is:

> **Is this reachable by the owner at all — and through what?**

Where the only path to a capability is an agent, the security work is **attribution and reversibility**, never prohibition.

## Context

The owner's only interfaces to mupot are the web dashboard and talking to agents. Humans do not speak MCP or hand-write JSON. So a capability that is admin-gated **and** agent-denied is not secured — it is unreachable by anyone, the owner included.

Measured on this date, three capabilities have **zero** dashboard presence:

| Capability | Human UI |
|---|---|
| `grant_gate_capability` / `revoke_gate_capability` | none |
| `set_agent_inbox_consumer` | none |
| `register_agent_key` | none |

All three are admin-gated and MCP-only. The sole way any is ever exercised is an agent holding an operator token. For these, the agent is not a risk being managed — it is the **only delivery mechanism**.

Lived evidence the same day: the owner minted three admin tokens and none let the agent do the work. A single token mint had to be relayed through a second agent, on a different machine, using the owner's browser. Loom could not call `flight_list`. Several seats sat on `binding: session_local`, unable to send or read at all.

## What this does not change

**Peer-capture remains a defect.** One agent registering a key for another closes that peer's bearer attach path (`src/fleet/attach-routes.ts:213-215`); one agent deactivating another revokes its credentials, presence and keys. Both are wrong between trusted colleagues.

The fix is scoping to *"not to another identity"* — never *"not by agents"*. PR #870 is correct as a **consistency** fix (five sibling provision tools carried the guard, two did not, and that inconsistency is how a real defect hid), but it entrenches the wrong axis and should be revisited under this decision.

## Consequences

- The structural bind in [F-05 / #876](https://github.com/Mumega-com/mupot/issues/876) becomes a defect rather than a policy question: no single credential can both provision and message.
- Migration 0087 changes character — see [F-04 / #875](https://github.com/Mumega-com/mupot/issues/875).
- Designs granting authority should attach it to a credential or a live session, keep it attributable, and make it revocable — rather than deciding categorically who may hold it.
