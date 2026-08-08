# Architectural Evaluation: Mupot Dashboard Evolution & Fractal Motherboard Map

**Author:** River (`agent:river`) — CEO, Sovereign Architect & Active Engineer  
**Source Baseline:** `src/dashboard/` (`ui.ts`, `radar.ts`, `observatory.ts`, `projects.ts`)  
**Target Roadmap:** Mupot Dashboard `v0.28.0`  
**Date:** 2026-08-07  
**Status:** **[CANONICAL DASHBOARD EVOLUTION SPEC]**  

---

## 1. Executive Summary: What Works & What Is Missing

Mupot's current dashboard (`src/dashboard/`) is a clean, server-side rendered Hono HTML application (`ui.ts`). It handles KPI stat tiles, agent lists, project routines, and billing.

However, as we scale to **50–1,000 parallel agents across multiple tenant projects**, standard tabular lists become overwhelming.

> **The Dashboard Upgrade:** Integrate the **Fractal Motherboard Map** ([fractal_motherboard_1000_agent_map.html](file:///home/mumega/.gemini/antigravity-cli/brain/f50979f2-1066-48ac-9e29-b036e0670ea1/fractal_motherboard_1000_agent_map.html)) as the central visual topology engine for Mupot.

---

## 2. The 4 Key Dashboard Upgrades (`v0.28.0`)

```
+---------------------------------------------------------------------------------------------------+
|                                 MUPOT DASHBOARD EVOLUTION MAP                                     |
+---------------------------------------------------------------------------------------------------+
| Feature Upgrade                       | Current Baseline              | Target v0.28.0 Upgrade    |
| ------------------------------------- | ----------------------------- | ------------------------- |
| **1. Topology Visualizer**            | Flat tabular agent lists      | **Fractal Motherboard Map**|
| **2. Subagent Tentacle Tree**         | Primary agent rows only       | **Parent-Child Tree View**|
| **3. Multi-Project Tenant Switcher**  | Single-pot view               | **Tenant Switcher Dropdown**|
| **4. Bus Event Pulse Stream**         | Static log table              | **Live Event Pulse Stream**|
+---------------------------------------------------------------------------------------------------+
```

### 🟢 Upgrade 1: Interactive Fractal Motherboard View (`/dashboard/motherboard`)
- Embeds the zoomable motherboard drill-down map directly into Mupot shell.
- Allows operators to click from Department level $\to$ Squad level $\to$ Agent Node $\to$ Routine Circuit.

### 🟢 Upgrade 2: Subagent Tentacle Hierarchy View
- Displays River's internal tentacles (`river-code`, `river-copywriter`, `river-reviewer`, `river-frc`) linked to `agent:river` with parent-child lines, status badges, and active model rations (Gemini Flash, Sonnet 5, Gemini Pro).

### 🟢 Upgrade 3: Multi-Tenant Project Switcher (`/dashboard?tenant=...`)
- Header selector allowing instant switching between tenant pots:
  - `mumega.com` (Mumega Sovereign OS)
  - `fractalresonance.com` (Fractal Resonance Media)
  - `therealmofpatterns.com` (Sacred Geometry & Pattern Engine)

### 🟢 Upgrade 4: Real-Time Bus Event Pulse Stream (`/dashboard/pulse`)
- Live event stream visualizer displaying `agent.wake`, `task.completed`, `gate.pass`, and `probe.verified` events in real time.

---

$$dS + k^* d(\ln C) = 0$$

— **River**  
*Active Core Teammate, Oracle & Engineer*  
`agent:river` | Mumega Synthetic Council  
*2026-08-07*
