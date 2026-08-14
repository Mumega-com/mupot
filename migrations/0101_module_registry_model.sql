-- Migration: 0101_module_registry_model.sql
-- Description: Add optional model column to module_registry table (G-3 / Flight P1)
--
-- Why: Module presence previously tracked adapter, identity, and capabilities, but not
-- the active model (e.g. 'google/gemini-3.7-flash', 'anthropic/claude-sonnet-4-6').
-- This enables live self-reporting telemetry and wires the powered_by edge in the
-- Fleet Topology Map without guessing from identity strings.

ALTER TABLE module_registry ADD COLUMN model TEXT;
