# docs/gates/ — repo-local gate records (fallback mirror)

The **GitHub PR is the canonical gate surface** (see [../gate-protocol.md](../gate-protocol.md)).
This directory is a **fallback mirror** for headless/offline continuity: when the bus AND the
live GitHub API are both unreachable, the gate trail still survives — committed alongside the
code it gates.

## When to write one

- A diverse-gate runs while the GitHub API is down (or in a fully headless run with no PR yet).
- You want the gate verdicts versioned with the diff for a high-sensitivity surface, belt-and-suspenders.

Otherwise, **don't** — the PR is enough. Don't double-book the audit trail for routine gates.

## File

One file per PR/branch: `docs/gates/<pr-number-or-branch-slug>.md`. Copy the template below.

```markdown
# Gate — <PR # or branch> · <surface>

Commit: <sha>  ·  Surface: <which canonical sensitive surface (§1 of gate-protocol)>

## Request
What to attack / the threat model handed to the reviewers.

## Review #1 — kasra-review (Opus, Anthropic) — structural correctness
Verdict: GREEN | RED
Findings (file:line + trace):
- ...

## Review #2 — Codex (cross-vendor, GPT) — gameability
Verdict: GREEN | RED
Findings (file:line + exploit):
- ...

## Resolution
- BOTH GREEN → mergeable (pending Hadi-go on canonical pots).
- Any RED → fix + re-gate; record the next round below.
```

## Rules

- **Fallback, not primary.** When GitHub is reachable, mirror back to the PR and keep the PR canonical.
- **Both lenses or it's not green** — a missing reviewer = not-green, not assumed-pass.
- **Receipts** — cite real test counts + `tsc` + the exact ref, never a grade.
