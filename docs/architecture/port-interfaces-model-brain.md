# Model + Brain Port Interfaces — SEALED v1

> Substrate epic #167 S3. **Approved + sealed by Hadi 2026-06-16** (all 4 one-way-door decisions: yes).
> Interfaces live in `src/types.ts`. Grounded in `src/model/index.ts`, `src/agents/loop.ts`, `src/agents/metabolism.ts`.

## Versioning decision (delta from the proposal)
Port version is a **module constant** (`MODEL_PORT_VERSION = 1`, `BRAIN_PORT_VERSION = 1`), **not** a `readonly version` field on the interface — so adapters and the existing `{ chat }` test mocks stay structural while the parent still knows the contract version. A child manifest's `mupotPortVersion` references these. Additive fields = no bump; shape changes = v2 + parent migration shim (the PostHog no-versioning trap, avoided).

## Model port — `ModelPort` (already live → formalized)
```ts
export const MODEL_PORT_VERSION = 1 as const
export interface ModelChatOpts { model?: string; maxTokens?: number; temperature?: number }
export interface ModelPort { chat(messages: ModelMessage[], opts?: ModelChatOpts): Promise<string> }
```
- **Default adapter:** `createModel(env)` — routes via **AI Gateway** (BYOK, key brokered by the gateway, app never holds a raw key) or **Workers AI** fallback (zero-config). Already swappable.
- **Sealed:** the key-brokering path (a BYO adapter never sees raw keys; never logs the gateway token).
- **Swappable:** the adapter behind `chat()` — Workers AI · gateway-brokered provider · full BYO.

## Brain port — `BrainPort` (new) — RANK-ONLY
```ts
export const BRAIN_PORT_VERSION = 1 as const
export interface BrainContext {
  tenant: string
  goals: ReadonlyArray<{ agentId: string; okr: string; kpiProgress: number }>
  board: ReadonlyArray<{ taskId: string; status: string; agentId: string | null }>
  pulses?: ReadonlyArray<{ kind: string; at: number; payload?: unknown }>
  lastHumanDirective?: string | null
  budgetRemainingMicroUsd?: number
}
export interface BrainProposal { kind: 'spawn_task'|'wake_agent'|'noop'; agentId?: string; summary: string; doneWhen?: string; priority: number }
export interface BrainDecision { ranked: ReadonlyArray<BrainProposal>; rationale?: string }
export interface BrainPort { decide(ctx: BrainContext): Promise<BrainDecision> }
```
**The keystone seal:** the brain **RANKS / PROPOSES — never acts.** The sealed core applies the ranking through the autonomy + capability + budget gates. A swapped/BYO brain (sovereign C(t) #70, a YC-CEO brain) changes *what's proposed*, never bypasses a gate. Idempotent by contract (stable context → stable ranking → no spam = the rank-not-act discipline).
- **Sealed (brain can NEVER reach):** autonomy gate, capability/RBAC, budget meter, task write-path, cross-tenant isolation.
- **Swappable:** the ranking logic. Default adapter = current `metabolism` + `runGoalCycle` (next S3 task: refactor to emit `BrainDecision` proposals the core gates — behaviour-preserving).

## Remaining S3 work (gated)
1. Brain **default adapter** — refactor `metabolism`/`runGoalCycle` to emit `BrainDecision` (proposals), core consumes + gates. No behaviour change.
2. **One real swap** to prove the seam (e.g. a trivial alternate ModelPort or BrainPort behind the same interface).
3. Codex diverse-gate (sensitive surface) before merge.
