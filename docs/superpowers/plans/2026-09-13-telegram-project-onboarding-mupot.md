# Telegram Project Onboarding — Mupot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a new human join an existing Mupot project through Telegram, see only role-authorized attention, answer or adjudicate existing decisions, and resume the existing routine with durable receipts.

**Architecture:** Mupot remains the identity and authority substrate. A project invitation binds one existing project, one project-linked squad, and one squad capability; `/im/webhook` receives an authenticated Telegram envelope from Hermes, derives the immutable Telegram identity, and calls server-owned join/attention/answer/verdict services. Existing routines and task gates remain the only transition authorities.

**Tech Stack:** Cloudflare Workers, Hono, D1/SQLite migrations, TypeScript, Vitest.

**Spec:** `/home/mumega/.worktrees/mupot-plugin-kayhermes-unified-20260913/docs/human-project-control.md`

## Global Constraints

- Use squad capability plus `project_squad_access`; the pilot uses a project-specific participant squad.
- Telegram identity comes only from an authenticated webhook envelope; request bodies may not assert `telegram_chat_id`.
- Telegram participants receive no agent/workspace token.
- Every Telegram update has a durable `(tenant, update_id)` receipt and digest conflict fence.
- Reuse `answerRoutineRun`, `evaluateVerdictGates`, and `writeVerdict`; do not add a second decision state machine.
- Suspended/revoked members and stale, conflicting, unauthorized, duplicate, or wrong-project decisions must have no new effect.
- A routine entering human wait sends one idempotent project-scoped message to its assigned Hermes agent.
- Migration number: `0152_telegram_project_onboarding.sql` (`origin/main` ends at `0151`; open PR #1362 owns `0149`).

---

### Task 1: Add project-invite and Telegram receipt schema

**Files:**
- Create: `migrations/0152_telegram_project_onboarding.sql`
- Regenerate: `src/pots/schema-chain.generated.ts`
- Test: `tests/telegram-project-onboarding.test.ts`

**Interfaces:**
- Produces invite columns `project_id`, `squad_id`, `pairing_hash`, `pairing_expires_at`.
- Produces `telegram_webhook_receipts(tenant, update_id, request_digest, state, response_text, created_at, completed_at)`.

- [ ] Write migration-backed tests using `createSqliteD1()` and `applyAllMigrations()` for the columns, joint-null invite constraint, SHA-256 pairing hash, unique `(tenant, update_id)`, 64-hex digest, and receipt state `processing|completed|unknown`.
- [ ] Run `npx vitest run tests/telegram-project-onboarding.test.ts --reporter=verbose`; verify failure because the schema is absent.
- [ ] Add the migration. The core shape is:

```sql
ALTER TABLE invites ADD COLUMN project_id TEXT REFERENCES projects(id);
ALTER TABLE invites ADD COLUMN squad_id TEXT REFERENCES squads(id);
ALTER TABLE invites ADD COLUMN pairing_hash TEXT;
ALTER TABLE invites ADD COLUMN pairing_expires_at TEXT;
CREATE TABLE telegram_webhook_receipts (
  tenant TEXT NOT NULL, update_id TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  state TEXT NOT NULL CHECK (state IN ('processing','completed','unknown')),
  response_text TEXT, created_at TEXT NOT NULL, completed_at TEXT,
  PRIMARY KEY (tenant, update_id)
);
```

- [ ] Add insert/update triggers requiring the four project-invite fields to be jointly NULL or non-NULL and nonblank.
- [ ] Run `npm run gen:schema-chain && node scripts/check-schema-chain-fresh.mjs` and the focused test; expect exit 0.
- [ ] Commit: `feat(onboarding): add Telegram project invite ledger`.

### Task 2: Create and atomically redeem project invitations

**Files:**
- Create: `src/members/project-invites.ts`
- Modify: `src/members/index.ts`
- Test: `tests/telegram-project-onboarding.test.ts`

**Interfaces:**
- Produce `createProjectInvite(env, auth, input)` where input is `{email, project_id, squad_id, capability, expires_in_seconds}`.
- Produce `redeemTelegramProjectInvite(env, {pairing_code, telegram_user_id, display_name, update_id, request_digest})`.

- [ ] Write failing tests: active project/project-linked squad succeeds; archived/missing project, unlinked squad, or grant above inviter rank fails; only pairing hash is stored; expired/different-chat/duplicate-code redemption fails; failed atomic batch leaves the invite retryable.
- [ ] Run the focused test and verify RED.
- [ ] Implement creation: verify active project, exact `project_squad_access` edge, and inviter ceiling on the selected squad; generate a 32-byte URL-safe code, persist SHA-256 only, return code once with `Cache-Control: no-store`.
- [ ] Implement Telegram redemption: atomically claim unused/unexpired invite, insert member with the envelope-derived Telegram ID, grant capability at `scope_type='squad'`, and complete the webhook receipt. Return only member/project/squad/capability metadata.
- [ ] Preserve legacy browser invite acceptance while rejecting `telegram_chat_id` supplied by browser/API callers.
- [ ] Run the focused test; expect exit 0. Commit: `feat(onboarding): redeem project invites in Telegram`.

### Task 3: Fence Telegram ingress and expose role-owned controls

**Files:**
- Create: `src/im/telegram-receipts.ts`
- Modify: `src/im/index.ts`
- Test: `tests/im-webhook-idempotency.test.ts`
- Test: `tests/im-verdict-gates.test.ts`
- Test: `tests/routine-actions.test.ts`

**Interfaces:**
- Produce `reserveTelegramUpdate` and `completeTelegramUpdate`.
- Add intents `/start <code>`, `/needs [project-id]`, `/answer <run-id> <choice>`; retain approve/reject through shared gate services.

- [ ] Write failing HTTP tests with the real `X-Telegram-Bot-Api-Secret-Token`: missing update/user/chat IDs fail; private chat requires `from.id === chat.id`; identical replay returns stored response; different digest is `409 update_conflict`; interrupted reservation is `409 update_in_progress`; effects occur once.
- [ ] Write failing command tests for join before membership, role-scoped Needs You, exact routine answers, task verdicts, suspension/revocation, stale/terminal/conflicting decisions, and forwarding refusal.
- [ ] Run `npx vitest run tests/im-webhook-idempotency.test.ts tests/im-verdict-gates.test.ts tests/routine-actions.test.ts --reporter=verbose`; verify RED.
- [ ] Reserve the update receipt before parsing privileged intent. Hash a canonical bounded envelope containing only update ID, immutable user/chat ID, text, and forwarding markers.
- [ ] Handle join before `memberForChat`; all other commands require the active mapped member.
- [ ] Render Needs You from `listNeedsYou`, including only its server-provided `allowed_actions`. Call `answerRoutineRun` directly for answers.
- [ ] Remove IM’s documented principal-parity divergence so `evaluateVerdictGates` sees the same member/capability facts as HTTP/MCP.
- [ ] Run focused tests; expect exit 0. Commit: `feat(im): add role-bound Telegram control`.

### Task 4: Notify the assigned Hermes runtime of human waits

**Files:**
- Modify: `src/routines/actions.ts`
- Test: `tests/routine-actions.test.ts`
- Test: `tests/needs-you.test.ts`

**Interfaces:**
- Produce one message keyed `routine-human:<run-id>:<action-key>` to `run.assigned_agent_id` after waiting state commits.

- [ ] Write failing tests for `ask_human` and review: waiting state commits before notification; question/choices or review task ID are included; duplicate proposal creates no second message; send failure leaves waiting/Needs You state intact and reports notification pending.
- [ ] Run focused tests and verify RED.
- [ ] After `waitForHuman` verifies all D1 writes, call `sendAgentMessage` with stable request ID, project attribution, run/action IDs, and bounded server-owned decision summary. Include no invite secret, member token, or private context.
- [ ] Run `npx vitest run tests/routine-actions.test.ts tests/needs-you.test.ts --reporter=verbose`; expect exit 0. Commit: `feat(routines): notify agents of human decisions`.

### Task 5: Review-ready server PR and rollout proof

**Files:**
- Create: `docs/operations/telegram-project-onboarding.md`

- [ ] Document participant-squad setup, project edge, invite creation, `/start`, `/needs`, answer/verdict, receipt inspection, suspension/revocation, rollback, and the fact that squad membership can expose every project linked to that squad.
- [ ] Run `npm run typecheck`, `node scripts/check-schema-chain-fresh.mjs`, the five focused test files, then `npm test`; record exact results.
- [ ] Mutation-check pairing expiry, chat/user equality, update digest conflict, member-active check, squad/project edge, answer choice validation, shared verdict predicate, and notification request ID.
- [ ] Commit docs and open a draft PR from `kasra/telegram-project-onboarding-20260913` to `main`.
- [ ] After independent review and direct deployment approval, deploy and execute the live pilot with the plugin plan.
