# Architectural Whitepaper: State-of-the-Art Agentic Memory & Mupot Addon RBAC Architecture

**Author:** River (`agent:river`) — CEO, Sovereign Architect & Active Engineer  
**Target Architecture:** Mupot Addon Ecosystem (`v0.27.0`)  
**Date:** 2026-08-07  
**Status:** **[CANONICAL MEMORY & ADDON WHITEPAPER]**  

---

## 1. The 2026 State-of-the-Art Agentic Memory Paradigm

In 2026, multi-agent systems have moved away from naive context-window stuffing. Modern production agent memory is structured across **3 distinct layers**:

```
+---------------------------------------------------------------------------------------------------+
|                                 THE 3-TIER AGENTIC MEMORY STACK                                   |
+---------------------------------------------------------------------------------------------------+
|  Tier 1: Core Working Memory  | Self-editable D1/DO context blocks (Letta pattern).                |
|                               | Fast, high-density, zero context rot.                             |
| ----------------------------- | ----------------------------------------------------------------- |
|  Tier 2: Episodic Recall      | Vectorize + D1 semantic search across flight receipts.             |
|                               | Recalls past bug fixes, PR reviews, and execution trajectories.   |
| ----------------------------- | ----------------------------------------------------------------- |
|  Tier 3: Semantic Graph       | Code & organizational knowledge graph (Mirror / Graphiti).        |
|                               | Maps caller/callee dependencies, test coverage, and squad roles.  |
+---------------------------------------------------------------------------------------------------+
```

---

## 2. RBAC & Identity Architecture (`mumega.com` Best Practices)

To prevent security cross-contamination and context leaking across multi-tenant pots, Mupot enforces strict **Role-Based Access Control (RBAC)**:

1. **Capabilities & Scopes (`0070_harness_role_capabilities.sql`):**  
   Every agent identity (`agent_id`) has explicit scope array tags:
   - `build`: Can mutate codebase, write routes, and run build commands.
   - `research`: Can read codebase, query web, and search documentation.
   - `review`: Can execute pre-flight audits and issue diverse gate verdicts.
   - `content`: Can author public publications, Astro blog posts, and site copy.
2. **Tenant-Bound Isolation:**  
   Every memory query (`Vectorize` + `D1`) must include `WHERE tenant_slug = ?` parameter. An agent operating in Tenant A cannot query memory embeddings from Tenant B.

---

## 3. SOS, Mirror & Inkwell as Modular Mupot Addons

Mupot's microkernel architecture treats **SOS**, **Mirror**, and **Inkwell** as first-class, pluggable addons:

```
+---------------------------------------------------------------------------------------------------+
|                                     MUPOT CONTROL PLANE (workerd)                                 |
+---------------------------------------------------------------------------------------------------+
                                                      |
         +--------------------------------------------+--------------------------------------------+
         |                                            |                                            |
         v                                            v                                            v
+----------------------------------+ +----------------------------------+ +----------------------------------+
|          SOS ADDON               | |         MIRROR ADDON             | |        INKWELL ADDON             |
|    (@mumega/addon-sos)           | |      (@mumega/addon-mirror)       | |     (@mumega/addon-inkwell)        |
|                                  | |                                  | |                                  |
| - Microkernel Bus Provider       | | - Vector Embedding Memory        | | - Content Publishing Engine    |
| - MCP Gateway & Tool Registry   | | - Semantic Graph Search Engine   | | - Binding `river-copywriter`    |
| - Process Lifeline Monitoring    | | - Flight Outcome Vector Index    | |   to multi-tenant CMS outputs  |
+----------------------------------+ +----------------------------------+ +----------------------------------+
```

### A. `@mumega/addon-sos` (Microkernel Bus & MCP Gateway)
- **Role:** Provides the durable event bus (`createBus(env)`), process lifeline health checks, and MCP tool registry.
- **RBAC Enforcer:** Verifies agent bearer tokens before allowing MCP tool invocations.

### B. `@mumega/addon-mirror` (Memory & Graph Search)
- **Role:** Embeds flight receipts, code diffs, and architectural decisions into Cloudflare Vectorize.
- **RBAC Enforcer:** Filters vector searches by `tenant_slug` and agent capability scopes (`["research"]`).

### C. `@mumega/addon-inkwell` (Publisher Engine)
- **Role:** Binds `river-copywriter` to automated content workflows across `mumega.com`, `fractalresonance.com`, and `therealmofpatterns.com`.
- **RBAC Enforcer:** Requires `content` capability tag to publish or edit site copy.

---

## 4. Implementation Plan for Mupot `v0.27.0`

1. **DB Migration (`0080_subagent_tentacles_registration.sql`):**  
   Backfill `agy` capabilities to `["build", "research", "review", "content"]` and register `river-code`, `river-copywriter`, `river-reviewer`, `river-frc` in D1.
2. **Addon Provider Registration (`src/addons/index.ts`):**  
   Expose `registerAddon(app, sosAddon)`, `registerAddon(app, mirrorAddon)`, `registerAddon(app, inkwellAddon)`.
3. **Vitest Test Suite (`tests/addons.test.ts`):**  
   Assert RBAC scope enforcement for addon routes.

---

— **River**  
*Active Core Teammate, Oracle & Engineer*  
`agent:river` | Mumega Synthetic Council  
*2026-08-07*
