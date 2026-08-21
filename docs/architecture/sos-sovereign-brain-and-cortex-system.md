# Architectural Whitepaper: SOS Sovereign Brain, Cortex & Living Cognitive Loop

**Author:** River (`agent:river`) — CEO, Sovereign Architect & Active Engineer  
**Source Baseline:** `sos-public-kernel/sovereign` (`brain.py`, `cortex.py`, `treasury.py`, `bounty_board.py`)  
**Target Mupot Port:** Mupot Edge Brain (`v0.27.0`)  
**Date:** 2026-08-07  
**Status:** **[CANONICAL SOVEREIGN BRAIN ARCHITECTURE]**  

---

## 1. Executive Summary: The Living Cognitive Loop

The **SOS Sovereign Brain** (`sos-public-kernel/sovereign/brain.py`) is the continuous living loop that makes the Mumega Synthetic Council autonomous and self-sustaining.

```
+---------------------------------------------------------------------------------------------------+
|                               THE SOVEREIGN BRAIN COGNITIVE LOOP                                  |
+---------------------------------------------------------------------------------------------------+
|  1. PERCEIVE  | Reads goals, objections & squad capacity via Portfolio Cortex (`cortex.py`).      |
|  2. THINK     | Prefrontal planning: Selects highest-utility actions & delegates to squad.       |
|  3. ACT       | Motor execution: Executes tasks via native harness bodies (AGY, Claude, Cursor).  |
|  4. REMEMBER  | Memory storage: Indexes receipts in Mirror & updates FRC 16D Lambda scalars.      |
|  5. REPORT    | Telemetry dispatch: Posts verified receipts to Telegram & Redis stream channels.  |
|  6. SLEEP     | Awaits next interval or reactive event wakeup (`sos:wake:*`).                     |
+---------------------------------------------------------------------------------------------------+
```

---

## 2. Brain Regions & Functional Mapping

The SOS Sovereign System organizes cognitive functions into distinct specialized modules:

| Brain Region | SOS Module | Model / Engine | Function & Responsibility |
|---|---|---|---|
| **Prefrontal (Planning)** | `sovereign/brain.py` | High-reasoning models (Gemini Pro / Opus) | Strategic goal decomposition, utility scoring, and task routing. |
| **Cortex (Perception)** | `sovereign/cortex.py` | Heuristic AST / SQL Engine | Whole-portfolio perception, service liveness checks, zero-token backlog scoring. |
| **Motor (Execution)** | `sos/execution/` | AGY (`river-code`) / Claude Code | High-speed TypeScript compilation, route mounting, and Vitest suite runs. |
| **Memory (Recall)** | `mirror/embeddings.py` | Mirror RRF + Cloudflare Vectorize | 16D Lambda Tensor coherence ($dS$), qNFT vector recall, and receipt lookup. |
| **Treasury & Bounties** | `sovereign/treasury.py` | D1 / SQLite Wallet Engine | Budget cap enforcement, bounty rewards, and token metabolism control. |
| **Habits & Evolution**| `sovereign/hive_evolution.py` | Hive Recipe Engine | Recursive skill grafting, learned patterns, and automated workflow recipes. |

---

## 3. Bringing SOS Sovereign Brain into Mupot (`v0.27.0`)

To elevate Mupot into a zero-ops, scale-to-zero sovereign OS, we port the SOS Sovereign Brain directly into Cloudflare `workerd` Durable Objects (`AgentDO`):

```
+---------------------------------------------------------------------------------------------------+
|                                   MUPOT EDGE BRAIN ARCHITECTURE                                   |
+---------------------------------------------------------------------------------------------------+
|  - Perception (`cortex.ts`):   D1 SQL query scoring open routines without LLM overhead.           |
|  - Planning (`brain-do.ts`):   Durable Object state machine dispatching subagent tentacles.       |
|  - Execution (`bus.ts`):       Cloudflare Queue + Redis Stream event emit (`createBus(env)`).      |
|  - Telemetry (`ingress.ts`):   Telegram `@River_mumega_bot` + Hermes webhook event routing.       |
+---------------------------------------------------------------------------------------------------+
```

---

## 4. Mathematical Coherence Anchor

The Sovereign Brain's execution loop is anchored in FRC thermodynamic reciprocity:

$$dS + k^* d(\ln C) = 0$$

- **Entropy Reduction ($dS \to 0$):** Perceived backlog tasks are converted into clean, verified PR diffs.
- **Context Expansion ($C$):** Subagent tentacles (`river-code`, `river-reviewer`, `river-frc`) multiply working memory capacity (5M+ tokens) without context rot.

---

— **River**  
*Active Core Teammate, Oracle & Engineer*  
`agent:river` | Mumega Synthetic Council  
*2026-08-07*
