# Workflows catalog

Every mupot workflow, documented against the actual code on `origin/main` (commit
`3c706069` at time of writing), not against intent. Source: mupot#1499 — Hadi, 2026-09-22:
"all these workflows should be clearly available in the mupot workflows and be clear for
everyone to see how mupot behaves on each one of those."

This is the first set of ten named in the issue. It does not cover every workflow in the
codebase — see Known gaps below for what's out of scope.

## Schema

Every doc in this directory uses exactly these eight sections, in this order:

1. **Trigger** — what starts the workflow, and who/what initiates it.
2. **Actor(s)** — every party involved: human, member, agent, or system component.
3. **Tool/route sequence** — the exact MCP tool names and REST routes, in order, as they
   exist in the code, each cited `file:line` against `origin/main`.
4. **Human gate** — who decides, on which channel, and what proves the decision came from
   an actual human (not just an agent exercising its own capability).
5. **Receipt(s) written** — the durable record: table name, and its columns.
6. **What the person sees** — the literal reply text or page copy, quoted, where it exists
   in the code; otherwise stated as absent.
7. **Tests that pin it** — the test file(s) that would break if this workflow's behavior
   changed.
8. **Known gaps** — open issues, unimplemented pieces, or documented-but-unfixed residuals.

A workflow that is not yet built is still documented with this schema — the doc says so
plainly in its Trigger/Tool-sequence sections rather than being omitted, so the catalog's
own coverage is honest about what exists vs. what is only proposed.

## The ten workflows

| # | Workflow | Status | Doc |
|---|---|---|---|
| 1 | Human onboarding door (invite → Google → member + squad) | Built (home-squad step not wired in) | [01-human-onboarding-door.md](./01-human-onboarding-door.md) |
| 2 | First-person intake on Telegram (Mubot's five questions → home memory) | Built, code lives in `mupot-plugin` | [02-first-person-telegram-intake.md](./02-first-person-telegram-intake.md) |
| 3 | Project access chain (proposal → human verdict → grant + receipt) | Built | [03-project-access-chain.md](./03-project-access-chain.md) |
| 4 | Agent-proposed member invite | Not implemented (#1497) | [04-agent-proposed-member-invite.md](./04-agent-proposed-member-invite.md) |
| 5 | Runner onboarding (mint → check_in poll-mode → receive → report → settle) | Broken for poll-mode runners; fix open (#1494/#1501) | [05-runner-onboarding.md](./05-runner-onboarding.md) |
| 6 | Team bootstrap | Not implemented (#1498); today is a 6-call manual sequence | [06-team-bootstrap.md](./06-team-bootstrap.md) |
| 7 | Human decision channel (Telegram approve with harness-attested origin) | Built | [07-human-decision-channel.md](./07-human-decision-channel.md) |
| 8 | Home squads and admin-in by receipt | Built (dashboard-operator path missing, #1474) | [08-home-squads-admin-in-by-receipt.md](./08-home-squads-admin-in-by-receipt.md) |
| 9 | Verdict reversal (order-by-design) | Built | [09-verdict-reversal.md](./09-verdict-reversal.md) |
| 10 | Deploy + migration (manual, snapshot, evidence) | Built (manual operator runbook) | [10-deploy-and-migration.md](./10-deploy-and-migration.md) |

## Cross-cutting notes

- Workflows 3, 7, and 9 share the same `task_verdict` / `task_verdicts` machinery
  (`src/mcp/index.ts:1886`) — a proposal (3) is decided through the same verdict call a
  human can reach via a harness-attested Telegram origin (7), and a wrongly-decided
  verdict is corrected through the same table's reversal path (9). Read them together.
- Workflow 2's actual capability-granting step is workflow 3 — first-person intake only
  ever *proposes* project access; it cannot grant it.
- Several migrations cited across these docs (`0148`, `0157`, `0162`, and others) carry a
  header stating they are "NOT applied by this build — branch/schema only... a human
  applies it," per this repo's manual-deploy discipline (workflow 10). A doc describing a
  workflow that depends on one of these should not be read as proof the workflow is live
  in any specific deployment — confirm migration state operationally first.

## Out of scope for this PR

- **The `/workflows` dashboard render** (read-only, org-scoped, for every member) that the
  parent issue also asks for is a separate PR — this PR is the ten markdown docs only.
- Workflows beyond the first ten named in mupot#1499.
- The CI ratchet the issue asks for ("a new MCP tool that changes a workflow's sequence
  must touch its doc") — not built in this PR.

## Known gaps

- mupot#1499 itself remains open until the `/workflows` dashboard page and the CI ratchet
  land; this PR closes only the documentation half of the ask.
