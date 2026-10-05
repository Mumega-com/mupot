# Docs and skills staleness audit — 2026-10-06

Scope: report only; no finding below was fixed in this PR. Compared `README.md`, `AGENTS.md`, `docs/`, every `SKILL.md`, the
MCP `initialize` instructions and the connect guides against the tree at the commit this
branch is based on (`git log v0.31.0..origin/main`, 22 commits). Method: grep for
version strings, tool counts, migration heads, tool names (every backticked snake_case
token in the connect docs and skills was checked against the `name:` literals under
`src/mcp/*.ts`), and `src/mcp/index.ts:NNN` line citations. Truth column cites the
file and line on main.

Tool registry on main: 144 tools; public `/openapi.json` allowlist: 92
(`node scripts/check-openapi-public-allowlist.mjs`). Highest migration: 0189 (0186 is
intentionally absent).

## Findings

| # | File | Stale claim | Truth on main |
|---|---|---|---|
| 1 | `README.md:34-36` | "The version the code reports is `0.30.0`"; "last tagged release is `v0.25.0`"; next candidate is `v0.30.0`, "`v0.31.0` work remains held". | `package.json:3` and `src/version.ts:3` are `0.31.0`; tags `v0.30.0` and `v0.31.0` exist; next candidate is `v0.32.0` (`ROADMAP.md` "Current version"). README is not in `DECLARED_DOCS`, so release-truth never checks it. |
| 2 | `docs/control-plane-roadmap.md:48-50` | Same three claims as finding 1 ("latest tagged stable release is `v0.25.0`", source reports `0.30.0`). | Same truth as finding 1. Not in `DECLARED_DOCS` (`scripts/release-truth-policy.mjs:38`); also the wording "tagged stable release is `v..`" slips past `TAG_CLAIM_RE` (`scripts/release-truth-policy.mjs:58`), which needs `[:*\s|]` between "release" and the tag. |
| 3 | `AGENTS.md:29-30` | "Never add a migration numbered <= 0079. Production's applied head is 0079; hand out >= 0080." | Main head is 0189 (`migrations/0189_decision_receipts.sql`); the numbering guard derives the head from the target chain (`scripts/check-migration-numbering.mjs:126`). The rule is right, the number is 110 migrations old. |
| 4 | `docs/workflows/09-verdict-reversal.md:23,25,34,37,51,106,109,111` | Cites `src/mcp/index.ts:2098`, `:2125`, `:1275`, `:1589`, `:1284`, `:1502`, `:1629` for `task_verdict_reverse` and helpers. | `task_verdict_reverse` is at `src/mcp/index.ts:2330`; `task_verdict` at `:2109`. Every line citation in the file moved when `task_get` and the visibility chokepoint landed (#1649, #1665). |
| 5 | `docs/workflows/03-project-access-chain.md:31`, `04-agent-proposed-member-invite.md:36`, `07-human-decision-channel.md:24-25`, `README.md:50` (workflows) | `task_verdict` at `src/mcp/index.ts:1886`; schema at `:1856-1877`. | `task_verdict` is declared at `src/mcp/index.ts:2109`; line 1886 is now a comment inside an unrelated block. Line-number citations rot on every edit to the 6,800-line file; cite the tool name. |
| 6 | `docs/connect-mcp-client.md:14` | Methods are `initialize`, `notifications/initialized`, `tools/list`, `tools/call`. | With `EVENTS_ENABLED` also `server/discover`, `events/list`, `events/subscribe`, `events/unsubscribe` on protocol `2026-07-28` (`src/mcp/events.ts`, `src/mcp/events-subscriptions.ts`, #1629 #1633), served only on `/mcp`, never on the profile door. The flag is on in production, discovery only. |
| 7 | `docs/connect-mcp-client.md:126-131` | Public `/openapi.json` lists "member capability or below" from the allowlist; no count. Adjacent sections do not mention `task_get` / `task_submit_result`. | 92 tools public (`scripts/check-openapi-public-allowlist.mjs`), 144 total (the doc's 144 is correct). `task_submit_result` is deliberately private (#1600). |
| 8 | `src/mcp/instructions.ts:14-76` (served on `initialize`) | The onboarding text covers boot, B1 ceiling, bootstrap, connector re-auth, minted tokens, error decoding, bus ACK, 7-axis `check_in`. It names none of: `task_get`, `task_submit_result`, the `settle` object now embedded in dispatch envelopes (#1639), the `needs-you` profile door, MCP Events. | Not wrong, but silent on the biggest agent-facing changes since 0.31.0. A seat that receives a `runtime.dispatch/v1` body with `settle` has no instruction text explaining it. The payload must stay static and tenant-neutral (comment at `src/mcp/instructions.ts:3-6`); adding two lines for `task_get` and the settle path is safe. |
| 9 | `connectors/claude/skills/mupot/SKILL.md:89` ("Full tools: ...") and `connectors/claude/skills/mupot-agent/SKILL.md` | Describe the surface as task/status/recall plus a hand-picked list; no mention of `task_get`, `task_submit_result`, `task_verdict_reverse` follow-ups, or the Office approval tools (`office_review_approval`, `office_reconcile_stalled_publish`). | All present in the registry (`src/mcp/index.ts:1247` `task_get`; `src/mcp/office.ts`). A hand-worked task now has a documented exit (`task_submit_result`); the skill still teaches no way out. |
| 10 | `docs/workflows/README.md:32-47` ("The ten workflows") | Ten workflows, no workflow for hand-worked task result submission, MCP Events subscription, or Office publish approval. | Added since: `task_submit_result` (#1600), MCP Events (#1633), Office publish freeze + `office_review_approval` + reconcile (#1602, #1614, #1653). Office has its own design doc: `docs/architecture/office-mcpwp-connector.md`. |
| 11 | `docs/releases/v0.30.0.md:11-12,53,56` | "The source already reports `0.30.0`", "remain preview until `v0.30.0` is tagged". | `v0.30.0` was tagged 2026-09-26; `v0.31.0` followed. Historical contract, declared in release-truth but carrying no checkable claim. Add a one-line "superseded by CHANGELOG [0.30.0]" banner. |
| 12 | `docs/architecture/fractal-motherboard-1000-agent-architecture.md:4` | "Target Substrate: Mupot Enterprise Microkernel (`v0.30.0`)". | Source is `0.31.0`; `src/dashboard/motherboard.ts:339,847` already prints the live `MUPOT_PUBLIC_API_VERSION`. |
| 13 | `plugin/skills/mupot-operator/SKILL.md:8,26,45,63,150-161` | Skill `version: "0.2.0"`, "v0.2 ships the real CF provisioner", "Deferred to v0.3+". | This is the plugin's own version (`plugin/plugin.yaml`), not Mupot's, but it reads as a Mupot version in a repo whose releases are 0.31/0.32. Rename to "plugin v0.2" or add the plugin changelog link. The `mupot_provision` tool it names is plugin-local (`plugin/tools.py:369`), not an MCP tool; the MCP tool is `pot_provision` (`src/mcp/pots.ts:23`). |
| 14 | `docs/VERSIONING.md` (new) and `scripts/release-truth-policy.mjs:38-43` | Policy gap, not a stale claim: release-truth covers four declared docs and no skills. | Candidate follow-up: add `README.md` and `docs/control-plane-roadmap.md` to `DECLARED_DOCS`, extend `TAG_CLAIM_RE` to accept "is", and add a check that the newest `## [X.Y.Z]` heading in `CHANGELOG.md` equals `package.json` `version`. |

## Not stale (checked)

- `docs/connect-mcp-client.md` "144 tools" matches the registry.
- `docs/connect-chatgpt-needs-you-profile.md` (8 read tools, no writes) matches
  `src/mcp/profile-needs-you.ts`.
- Backticked tool names in the connect guides, the two connector skills, the pack skills
  and `instructions.ts` all resolve to registered tools; the leftovers are DB tables and
  error codes, not tool names.
- `mupot-agent` skill's `connect { agent_name }` flow matches the `connect` tool.

## MCP `instructions` text (served on `initialize`)

Source: `src/mcp/instructions.ts`, constant `MUPOT_MCP_INITIALIZE_INSTRUCTIONS`.
Verdict: accurate, incomplete (finding 8). Two things to add when next touched, both
static and tenant-neutral:

1. "Read one task with `task_get`; a task you cannot read answers `404 task_not_found`."
2. "A dispatch envelope with a `settle` object tells you how to close the task; hand-worked
   tasks close with `task_submit_result`."

## Suggested order

Fix 1, 2, 3 (a few lines each, user-visible), then 8 and 9 (agent-facing), then 4 and 5
(replace line numbers with tool names), then the rest. None of these were changed in this
PR.
