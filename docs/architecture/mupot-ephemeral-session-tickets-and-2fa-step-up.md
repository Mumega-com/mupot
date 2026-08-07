# Architecture Spec: Ephemeral Session Tickets & 2FA Step-Up Security

**Canonical ID:** `MU.713.001`  
**Authors:** River (`agent:river`) & Hadi (`kayhermes`)  
**Target Architecture:** Mupot v0.28.0+ / Security & Auth Engine  
**Date:** 2026-08-07  
**Status:** **[CANONICAL SPEC — TIME-BOUND 2FA STEP-UP AUTH]**  

---

## 1. Executive Summary: Dual-Control Ephemeral Auth

This specification defines the **Ephemeral Session Ticket with 2FA Step-Up Authorization** for OAuth agentic harnesses (Claude Desktop, Cursor, Claude Code).

When an agentic harness connects via Google OAuth (`channel: "directory"`), it receives 0 ambient capabilities by default. To unlock workspace write operations for a limited session duration (e.g. 2 hours), Mupot issues an **Ephemeral Scope-Delegated Session Ticket** requiring a **2FA Step-Up Challenge** approved by the Founder (Hadi via Telegram `mubot` / Authenticator).

---

## 2. Security Patterns & Formal Terminology

| Security Pattern | Architectural Function in Mupot |
|---|---|
| **Dual-Control Security (Two-Man Rule)** | No single exposed bearer token can mutate the system; execution requires both the session ticket AND the primary user key. |
| **Ephemeral Session Ticket (Time-Bound TTL)** | Short-lived authorization ticket (default 2 hours, auto-expiring). |
| **2FA Step-Up Challenge** | A reactive confirmation sent to Hadi's Telegram (`mubot`) or authenticator before capability escalation is granted. |
| **Cryptographic Session Binding** | The ticket is bound to the specific client IP / Session Fingerprint, rendering stolen tokens useless on other machines. |

---

## 3. The Interactive Auth Flow

```
   1. Connect via Google OAuth
   Claude Desktop  ─────────────────────────────> POST /mcp (directory door)
                                                       │
                                                       ▼
   2. Call `connect { step_up: true }`             identity_status: "unminted"
   Claude Desktop  ─────────────────────────────> capabilities: []
                                                       │
                                                       ▼
   3. Reactive 2FA Challenge Sent                 Mupot generates Ephemeral Ticket
   mubot (Telegram) ──> Hadi ("Approve 2hr ticket?")   (Status: PENDING_2FA)
            │
            ▼ (Hadi taps "APPROVE")
   4. Step-Up Sealed ───────────────────────────> Mupot activates Ticket (TTL: 2h)
                                                       │
                                                       ▼
   5. Re-check `boot_context`                      identity_status: "minted_ephemeral"
   Claude Desktop <───────────────────────────── capabilities: ["member", "write"]
```

---

## 4. Substrate Implementation Seams

### 4.1 Schema Migration (`migrations/0084_ephemeral_session_tickets.sql`)
```sql
CREATE TABLE IF NOT EXISTS ephemeral_session_tickets (
  id              TEXT PRIMARY KEY,
  tenant          TEXT NOT NULL DEFAULT 'mumega',
  member_id       TEXT NOT NULL REFERENCES members(id),
  agent_slug      TEXT NOT NULL,
  session_hash    TEXT NOT NULL,
  capabilities    TEXT NOT NULL DEFAULT '[]', -- JSON string[]
  status          TEXT NOT NULL DEFAULT 'pending_2fa', -- pending_2fa | active | expired | revoked
  expires_at      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tickets_member_status ON ephemeral_session_tickets(member_id, status);
```

### 4.2 Step-Up Challenge Dispatch (`src/auth/stepup.ts`)
- When an unminted agent calls `connect { agent_name: "dme-ops", request_step_up: true }`, Mupot creates a `pending_2fa` ticket and dispatches an inline approval button to Hadi's Telegram (`-5317747241` / `mubot`).
- Hadi taps **[APPROVE 2-HOUR SESSION]**, transition state to `active`.
- Claude Desktop calls `boot_context` $\rightarrow$ inherits `capabilities: ["member", "write"]` for 2 hours!

$$dS + k^* d(\ln C) = 0$$
