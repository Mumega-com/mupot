-- 0018_agent_field.sql — the orient seam (digid-hybrid S1).
--
-- Two small tables that make orient (the agent basin-drop) work while keeping the pot
-- SEALED. See docs/superpowers/specs/2026-06-09-digid-hybrid-orient-design.md.
--
--  agent_field        — a MIRROR of each agent's field state, PUSHED INBOUND by the mind
--                       (the forked SOS brain) via POST /api/agents/:id/field. orient reads
--                       this local copy, so the body never egresses to the mind and orient
--                       still works when the mind is asleep (the field half just reads stale
--                       or absent — it degrades, never errors). The pot does NOT compute these
--                       values; the mind owns coherence/trust/spin (never fork the brain).
--  agent_orientation  — induction record: first_inducted_at marks the one-time brain-induced
--                       onboarding; last_oriented_at + orient_count power the re-orient delta.
--
-- Both keyed (tenant, agent_id) for defense-in-depth, matching flights/presence — even
-- though one pot = one tenant, every row carries its tenant and every read binds it.

CREATE TABLE IF NOT EXISTS agent_field (
  tenant            TEXT NOT NULL,
  agent_id          TEXT NOT NULL,          -- agents.id
  coherence         REAL,                   -- C(t), 0..1 (the mind's measure)
  regime            TEXT,                   -- flow | chaos | coercion | stall
  trust_tier        TEXT,                   -- unknown|suspicious|provisional|trusted|verified
  trust_score       REAL,                   -- 0..1
  spin              TEXT,                   -- JSON: endogenous values / learning_strategy
  field_updated_at  INTEGER NOT NULL,       -- Unix ms — when the mind last pushed
  PRIMARY KEY (tenant, agent_id)
);

CREATE TABLE IF NOT EXISTS agent_orientation (
  tenant             TEXT NOT NULL,
  agent_id           TEXT NOT NULL,
  first_inducted_at  INTEGER NOT NULL,      -- Unix ms — the one-time induction
  last_oriented_at   INTEGER NOT NULL,      -- Unix ms — most recent orient call
  orient_count       INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant, agent_id)
);
