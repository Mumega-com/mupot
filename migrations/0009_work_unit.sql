-- Work-unit schema: OKR / KPI / effort / autonomy / budget on agents + squads.
--
-- A mupot agent (and squad) is a managed WORK UNIT, not a chatbot.
-- These columns add the first-class unit fields so every row carries:
--   goal       → okr
--   target     → kpi_target / kpi_progress
--   effort     → effort (ceiling on spend/tool-calls in execute mode)
--   autonomy   → autonomy (maps to gate level — see below)
--   budget     → budget_cap_cents / budget_window
--
-- Enums (enforced at the service layer; D1 TEXT columns cannot be retroactively
-- constrained with ALTER TABLE, so we document them here):
--
--   effort ∈ { low, standard, high, sprint }
--     low      = conservative token/tool budget
--     standard = default balanced ceiling
--     high     = elevated; composes with rate-limit rules (#4)
--     sprint   = all-out, temporary burst mode
--
--   autonomy ∈ { suggest, draft, execute, execute_with_approval }
--     suggest              = read-only; surfaces ideas only
--     draft                = may create artefacts, cannot ship
--     execute              = full execution, ungated tasks
--     execute_with_approval = full execution, tasks auto-get gate_owner set
--
--   budget_window ∈ { day, week }
--     day  = rolling 24-hour window
--     week = rolling 7-day window
--
-- Design note: squads gain `role` here (the squad accountability line).
-- Agents already had `role` from 0001_init.sql.

-- ── agents ────────────────────────────────────────────────────────────────────
ALTER TABLE agents ADD COLUMN okr              TEXT;
ALTER TABLE agents ADD COLUMN kpi_target       TEXT;
ALTER TABLE agents ADD COLUMN kpi_progress     REAL    NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN effort           TEXT    NOT NULL DEFAULT 'standard';
ALTER TABLE agents ADD COLUMN autonomy         TEXT    NOT NULL DEFAULT 'draft';
ALTER TABLE agents ADD COLUMN budget_cap_cents INTEGER;
ALTER TABLE agents ADD COLUMN budget_window    TEXT    NOT NULL DEFAULT 'week';

-- ── squads ────────────────────────────────────────────────────────────────────
ALTER TABLE squads ADD COLUMN role             TEXT;
ALTER TABLE squads ADD COLUMN okr              TEXT;
ALTER TABLE squads ADD COLUMN kpi_target       TEXT;
ALTER TABLE squads ADD COLUMN kpi_progress     REAL    NOT NULL DEFAULT 0;
ALTER TABLE squads ADD COLUMN effort           TEXT    NOT NULL DEFAULT 'standard';
ALTER TABLE squads ADD COLUMN autonomy         TEXT    NOT NULL DEFAULT 'draft';
ALTER TABLE squads ADD COLUMN budget_cap_cents INTEGER;
ALTER TABLE squads ADD COLUMN budget_window    TEXT    NOT NULL DEFAULT 'week';
