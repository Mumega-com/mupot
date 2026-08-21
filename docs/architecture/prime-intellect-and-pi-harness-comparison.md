# Architecture Spec: Prime Intellect (PI) & Pi Harness vs. Ecosystem Harnesses

**Author:** River (`agent:river`) — CEO, Sovereign Architect & Active Engineer  
**Target Version:** `v0.27.0` (`connectors/pi`)  
**Date:** 2026-08-07  
**Status:** **[ARCHITECTURAL MATRIX SPEC]**  

---

## 1. Executive Summary: What is Prime Intellect & Pi?

**Prime Intellect (PI)** is a decentralized compute substrate and open-source AI infrastructure platform. It provides global distributed GPU clusters for open-weight model training, fine-tuning, and decentralized inference (DeepSeek v4, DeepSeek R1, Llama 3.3, INTELLECT-1).

**Pi CLI (`@earendil-works/pi-coding-agent`)** is an ultra-minimalist, open-source AI coding harness designed for terminal-native execution. Unlike heavy GUI frameworks, Pi communicates via `--mode rpc` (JSON-RPC stdio protocol) and supports **Tree Session Branching (`--fork`)**, allowing Mupot to branch failed execution paths cleanly without context pollution.

---

## 2. The 6-Harness Substrate Comparison Matrix

Mupot is harness-agnostic. It maps each agent identity to its optimal native harness body:

| Feature / Dimension | **Pi CLI (Prime Intellect)** | **AGY (Google Antigravity)** | **Claude Code (Anthropic)** | **Cursor IDE (Anysphere)** | **Hermes (Mubot Gateway)** | **Codex (OpenAI / Loom)** |
|---|---|---|---|---|---|---|
| **Substrate / Provider** | Open-Source / Prime Intellect | Google Cloud Substrate | Anthropic | Cursor / Grok / Sonnet | OpenClaw / Cloudflare AI | OpenAI / Loom |
| **Model Family** | Open-Weight (DeepSeek v4 / Llama 3.3) | Gemini 2.5 Flash / Pro | Claude Opus 5 / Sonnet 5 | Grok 4.5 / Sonnet 5 | DeepSeek v4 / Open Models | Codex / GPT-5 |
| **Execution Protocol** | `--mode rpc` (stdio JSON-RPC) | AGY CLI / IDE Sidecar | CLI Terminal Protocol | IDE RPC / Stdio Bridge | Gateway Webhook / Redis Bus | Stdio CLI |
| **Session Branching** | Native `--fork` Tree Branching | File/Context Snapshots | Git Branch Isolation | Git Branch / Workspace | Memory Session State | Git Worktree |
| **Sovereignty Level** | **100% Open / Decentralized** | Subscription Harness | Subscription Harness | Pro Subscription | **100% Edge / Open** | API / CLI Harness |
| **Primary Squad Role** | Open-Source Execution Worker | CEO, Architecture & Speed | Primary Builder & Operator | Adversarial Gating & Review | Telemetry & Channel Ops | Test & Implementer |

---

## 3. Mupot Pi Integration Architecture (`connectors/pi`)

Mupot integrates Pi via `connectors/pi/mupot-pi-driver.py` and `scripts/mint-pi-agent.mjs`:

```
+---------------------------------------------------------------------------------------------------+
|                                      MUPOT CORE BUS & TASK SPINE                                  |
+---------------------------------------------------------------------------------------------------+
                                                      |
                                                      | (Task Instructions + MUPOT_MEMBER_TOKEN)
                                                      v
+---------------------------------------------------------------------------------------------------+
|                                MUPOT PI DRIVER (connectors/pi/mupot-pi-driver.py)                |
|                                                                                                   |
|  1. Spawns `pi --mode rpc` via Subprocess Stdio                                                  |
|  2. If Task Retries Required: Spawns clean session branch via `pi --fork <SESSION_ID>`            |
|  3. Streams tool calls & task progress to Mupot D1 telemetry & DO bus                            |
+---------------------------------------------------------------------------------------------------+
```

---

## 4. Key Strengths of Pi vs. Other Harnesses

1. **Tree Session Branching (`--fork`):**  
   When an agent encounters a bug or broken path, standard harnesses pollute the main context window with error tracebacks. Pi allows Mupot to call `pi --fork <session_id>`, creating a parallel clean branch from the exact pre-error state.

2. **Zero-Bloat Stdio Footprint:**  
   Pi has zero heavy GUI overhead. It communicates purely over stdio JSON-RPC, making it the lightest execution worker for high-density agent squads.

3. **Prime Intellect Open-Weight Sovereignty:**  
   When paired with Prime Intellect's decentralized inference, Pi allows Mupot pots to run **100% open-source agent squads** (DeepSeek v4 / Llama 3.3) with zero reliance on proprietary API gates.

---

— **River**  
*Active Core Teammate, Oracle & Engineer*  
`agent:river` | Mumega Synthetic Council  
*2026-08-07*
