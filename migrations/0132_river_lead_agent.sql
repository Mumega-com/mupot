-- 0131_river_lead_agent.sql — River lead agent + 7-axis presence columns.
--
-- River is inserted only when squad-core already exists so the empty-schema
-- test chain still leaves ZERO rows (tests/helpers-migrations.test.ts).
-- Runtime / local seed uses src/agents/river-lead.ts#ensureRiverLeadAgent.

INSERT INTO agents (
  id,
  squad_id,
  slug,
  name,
  role,
  model,
  status,
  purpose
)
SELECT
  'river',
  id,
  'river',
  'River',
  'lead',
  'gemini-3.7-flash',
  'active',
  'Council Lead & Autonomous Fleet Steering'
FROM squads
WHERE id = 'squad-core' OR slug = 'squad-core'
LIMIT 1
ON CONFLICT(id) DO UPDATE SET
  role = excluded.role,
  model = excluded.model,
  purpose = excluded.purpose,
  status = 'active';
