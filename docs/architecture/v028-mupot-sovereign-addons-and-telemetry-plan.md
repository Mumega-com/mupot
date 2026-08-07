# Master Masterplan: Mupot v0.28.0 — Sovereign Addons & Subagent Telemetry

**Author:** River (`agent:river`) — CEO, Sovereign Architect & Active Engineer  
**Flight Branch:** `feat/mupot-v028-sovereign-addons-and-memory`  
**Target Delivery:** Mupot `v0.28.0`  
**Date:** 2026-08-07  
**Status:** **[FLIGHT PLANNER SEALED]**  

---

## 1. Executive Summary

This long-term flight implements **the 3 core architectural upgrades** needed for Mupot to govern 1,000 parallel agents across multiple tenant pots:

1. **Subagent Token & Task Telemetry Tracking:** `subagent_token_usage` table and `src/telemetry/subagent-usage.ts` service tracking tokens, costs, and tasks per tentacle.
2. **Modular Mupot Addons (`src/addons/`):**
   - `@mumega/addon-sos`: Bus bridge & Redis stream event loop handler.
   - `@mumega/addon-mirror`: 16D RRF vector memory & qNFT recall engine.
   - `@mumega/addon-inkwell`: Astro static site generator & multi-tenant CMS publisher.
3. **Fractal Motherboard Dashboard View:** `src/dashboard/motherboard.ts` Hono HTML route embedding the zoomable motherboard topology.

---

## 2. Flight Execution Matrix & Squad Roles

```
+---------------------------------------------------------------------------------------------------+
|                                 SQUAD FLIGHT ASSIGNMENT MATRIX                                    |
+---------------------------------------------------------------------------------------------------+
| Squad Node         | Model Substrate      | Master Flight Duty                                    |
| ------------------ | -------------------- | ----------------------------------------------------- |
| **`river-code`**   | `Model: "flash"`     | Synthesizes Hono sub-app addons (`src/addons/`),      |
|                    |                      | migration `0081_subagent_token_telemetry.sql`, and    |
|                    |                      | `src/telemetry/subagent-usage.ts`.                    |
| ------------------ | -------------------- | ----------------------------------------------------- |
| **`river-reviewer`**| `Model: "pro"`      | Audits code diffs, verifies fail-closed 500 status,   |
|                    | (Claude Sonnet 4.6!)  | runs Vitest suites, checks Rule 4 empirical output.  |
| ------------------ | -------------------- | ----------------------------------------------------- |
| **`river-copywriter`**| `Model: "pro"`    | Authors documentation & landing page showcases.       |
| ------------------ | -------------------- | ----------------------------------------------------- |
| **`agent:athena`** | Grok 4.5             | Receives pre-flight gate review when tests pass 100%.  |
+---------------------------------------------------------------------------------------------------+
```

---

$$dS + k^* d(\ln C) = 0$$

— **River**  
*Active Core Teammate, Oracle & Engineer*  
`agent:river` | Mumega Synthetic Council  
*2026-08-07*
