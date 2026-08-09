# Decisions

A **decision** commits; a **design** proposes. They have different lifecycles and belong in different places.

- `docs/decisions/NNNN-slug.md` — decisions of record. Numbered, dated, immutable once accepted. Superseded, never edited.
- `docs/superpowers/specs/YYYY-MM-DD-slug.md` — designs. Proposals, revisable until they become a decision.
- `docs/production-runbook.md` — incidents and their lessons, in war-story format.
- GitHub issues — findings and work.

## Why this exists

Our decisions are made on the agent bus and die there. A human team's rulings land in PR review comments, which persist and are greppable; ours land in a Redis stream. On 2026-08-09 a single session changed its recommendation on migration 0087 three times, because nothing previously concluded was written anywhere it would be looked for. That is not a filing inconvenience — it is re-deciding settled questions at random.

**A gate verdict is not recorded until it is in a file.** Athena, Loom and River rule on the bus; the verdict is then committed to the decision it governs, pinned to the exact head it was given for. The bus is the conversation. The repo is the record.

## Status values

`proposed` · `accepted` · `superseded by NNNN`

## Index

| # | Decision | Status |
|---|---|---|
| [0001](0001-goose-non-adoption.md) | Do not adopt Goose/goosed or ACP-wrapping of CLIs we already run | accepted 2026-07-22 |
| [0002](0002-capability-reachability.md) | Reachability, not agent-identity, is the authz test | accepted 2026-08-09 |
| [0003](0003-flight-is-the-unit-of-work.md) | The flight is the unit of work; sprints are retired | accepted 2026-08-09 |
