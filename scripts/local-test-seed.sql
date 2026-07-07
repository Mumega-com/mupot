-- Local smoke seed. Apply after all migrations:
--   npm run migrate:local:test
--   npm run seed:local:test

INSERT INTO org_settings (key, value, updated_at) VALUES
  ('onboarding_complete', 'true', datetime('now')),
  ('billing_state', '{"tier":"pro","event_id":"local-seed","effective_at":"2026-07-07T00:00:00.000Z"}', datetime('now'))
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;

INSERT INTO users (id, email, role, created_at)
VALUES ('usr-local-owner', 'local-owner@mupot.test', 'owner', datetime('now'))
ON CONFLICT(id) DO UPDATE SET email = excluded.email, role = excluded.role;

INSERT INTO departments (
  id, slug, name, created_at, template_key, template_version, activated_at, active, seed_receipt
) VALUES (
  'dept-growth', 'growth', 'Marketing & Sales', datetime('now'),
  'growth', 'local-test', datetime('now'), 1,
  '{"seeded_at":"local","squads":["growth"]}'
)
ON CONFLICT(id) DO UPDATE SET
  slug = excluded.slug,
  name = excluded.name,
  template_key = excluded.template_key,
  template_version = excluded.template_version,
  activated_at = excluded.activated_at,
  active = excluded.active,
  seed_receipt = excluded.seed_receipt;

INSERT INTO squads (
  id, department_id, slug, name, charter, created_at, role, okr, kpi_target,
  kpi_progress, effort, autonomy, budget_cap_cents, budget_window
) VALUES (
  'sq-growth', 'dept-growth', 'growth', 'Growth Local', 'Local browser and Hermes smoke squad.',
  datetime('now'), 'growth pod', 'Keep the local pot smokeable', 'All dashboard pages return HTTP 200',
  0.72, 'standard', 'execute_with_approval', 2500, 'week'
)
ON CONFLICT(id) DO UPDATE SET
  department_id = excluded.department_id,
  slug = excluded.slug,
  name = excluded.name,
  charter = excluded.charter,
  role = excluded.role,
  okr = excluded.okr,
  kpi_target = excluded.kpi_target,
  kpi_progress = excluded.kpi_progress,
  effort = excluded.effort,
  autonomy = excluded.autonomy,
  budget_cap_cents = excluded.budget_cap_cents,
  budget_window = excluded.budget_window;

INSERT INTO agents (
  id, squad_id, slug, name, role, model, status, created_at, okr, kpi_target,
  kpi_progress, effort, autonomy, budget_cap_cents, budget_window
) VALUES
  ('agent-hermes', 'sq-growth', 'hermes', 'Hermes Local', 'IM control and local smoke', '@cf/meta/llama-3.3', 'active', datetime('now'), NULL, 'local smoke passing', 0.66, 'standard', 'draft', 1500, 'week'),
  ('agent-growth', 'sq-growth', 'growth-lead', 'Growth Lead Local', 'Growth operator', '@cf/meta/llama-3.3', 'paused', datetime('now'), 'Improve local pipeline confidence', '3 smoke checks green', 0.45, 'low', 'suggest', 500, 'day')
ON CONFLICT(id) DO UPDATE SET
  squad_id = excluded.squad_id,
  slug = excluded.slug,
  name = excluded.name,
  role = excluded.role,
  model = excluded.model,
  status = excluded.status,
  okr = excluded.okr,
  kpi_target = excluded.kpi_target,
  kpi_progress = excluded.kpi_progress,
  effort = excluded.effort,
  autonomy = excluded.autonomy,
  budget_cap_cents = excluded.budget_cap_cents,
  budget_window = excluded.budget_window;

INSERT INTO memberships (id, agent_id, squad_id, capability)
VALUES
  ('memship-hermes-growth', 'agent-hermes', 'sq-growth', 'lead'),
  ('memship-growth-growth', 'agent-growth', 'sq-growth', 'member')
ON CONFLICT(id) DO UPDATE SET capability = excluded.capability;

INSERT INTO members (id, email, display_name, telegram_chat_id, status, created_at, tenant)
VALUES
  ('mbr-hermes-user', 'hermes@mupot.test', 'Hermes Test Operator', '123456789', 'active', datetime('now'), 'local'),
  ('mbr-local-admin', 'local-admin@mupot.test', 'Local Admin', NULL, 'active', datetime('now'), 'local')
ON CONFLICT(id) DO UPDATE SET
  email = excluded.email,
  display_name = excluded.display_name,
  telegram_chat_id = excluded.telegram_chat_id,
  status = excluded.status,
  tenant = excluded.tenant;

INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
VALUES
  ('cap-hermes-org-admin', 'mbr-hermes-user', 'org', NULL, 'admin'),
  ('cap-admin-org-owner', 'mbr-local-admin', 'org', NULL, 'owner')
ON CONFLICT(id) DO UPDATE SET capability = excluded.capability;

INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
VALUES
  ('gg-hermes-local', 'gate:local', 'member', 'mbr-hermes-user', 'usr-local-owner', datetime('now')),
  ('gg-hermes-content', 'content:write', 'member', 'mbr-hermes-user', 'usr-local-owner', datetime('now')),
  ('gg-hermes-budget', 'budget:write', 'member', 'mbr-hermes-user', 'usr-local-owner', datetime('now'))
ON CONFLICT(capability, principal_type, principal_id) DO UPDATE SET granted_by = excluded.granted_by;

INSERT INTO tasks (
  id, squad_id, title, body, status, assignee_agent_id, github_issue_url,
  created_at, updated_at, result, completed_at, gate_owner, cost_micro_usd,
  workflow_instance_id, done_when
) VALUES
  ('task-open-local', 'sq-growth', 'Open local smoke task', 'Verify the local dashboard can be reached.', 'open', 'agent-hermes', NULL, datetime('now','-90 minutes'), datetime('now','-80 minutes'), NULL, NULL, NULL, 12000, NULL, 'The local dashboard home returns HTTP 200.'),
  ('task-progress-local', 'sq-growth', 'In-progress local task', 'Exercise the browser crawl against authenticated pages.', 'in_progress', 'agent-hermes', NULL, datetime('now','-70 minutes'), datetime('now','-40 minutes'), NULL, NULL, NULL, 25000, NULL, 'The browser smoke report lists every dashboard page as passed.'),
  ('task-review-local', 'sq-growth', 'Review local approval task', 'Seeded row for the approvals and gate queue.', 'review', 'agent-growth', NULL, datetime('now','-55 minutes'), datetime('now','-20 minutes'), 'Draft result ready for approval.', NULL, 'gate:local', 9000, NULL, 'A reviewer approves or rejects this seeded local task.'),
  ('task-done-local', 'sq-growth', 'Done local task', 'Seeded completed task for observatory history.', 'done', 'agent-hermes', NULL, datetime('now','-4 hours'), datetime('now','-3 hours'), 'Completed local baseline.', datetime('now','-3 hours'), NULL, 43000, NULL, 'The local seed data is visible in the dashboard.')
ON CONFLICT(id) DO UPDATE SET
  title = excluded.title,
  body = excluded.body,
  status = excluded.status,
  assignee_agent_id = excluded.assignee_agent_id,
  updated_at = excluded.updated_at,
  result = excluded.result,
  completed_at = excluded.completed_at,
  gate_owner = excluded.gate_owner,
  cost_micro_usd = excluded.cost_micro_usd,
  workflow_instance_id = excluded.workflow_instance_id,
  done_when = excluded.done_when;

INSERT INTO task_verdicts (id, task_id, verdict, note, decided_by, decided_at)
VALUES ('verdict-local-done', 'task-done-local', 'approved', 'Seeded approval receipt.', 'mbr-hermes-user', datetime('now','-3 hours'))
ON CONFLICT(id) DO NOTHING;

INSERT INTO loops (id, tenant, squad_id, agent_id, status, spec, dry_rounds, created_at, updated_at)
VALUES (
  'loop-growth-local', 'local', 'sq-growth', NULL, 'active',
  '{"squad_id":"sq-growth","agent_id":null,"okr":"Generate local smoke confidence","kpi":{"signal":"positive_replies","target":3},"sources":[{"kind":"queue","name":"prospects"}],"channels":[{"kind":"mcp","url":"https://example.com/mcp","auth_ref":"LOCAL_TEST"}],"gate":{"require_approval":true,"timeout_sec":3600,"on_timeout":"pause"},"budget":{"cap_micro_usd":500000,"window":"day","effort":"standard"},"cadence":{"heartbeat":true,"on_event":true},"stop":{"dry_rounds_max":3,"on_kpi_met":false}}',
  0, datetime('now','-2 hours'), datetime('now','-10 minutes')
)
ON CONFLICT(id) DO UPDATE SET status = excluded.status, spec = excluded.spec, updated_at = excluded.updated_at;

INSERT INTO loop_decisions (id, loop_id, tenant, cycle_num, decided, perceived, acted, gated, kpi, error, capability_descriptor, recorded_at)
VALUES
  ('ld-local-1', 'loop-growth-local', 'local', 1, 'gated_pending', 3, 0, 1, 33, NULL, '{"model":"local"}', datetime('now','-45 minutes')),
  ('ld-local-2', 'loop-growth-local', 'local', 2, 'dry', 0, 0, 0, 33, NULL, '{"model":"local"}', datetime('now','-15 minutes'))
ON CONFLICT(id) DO UPDATE SET decided = excluded.decided, recorded_at = excluded.recorded_at;

INSERT OR IGNORE INTO prospects (id, tenant, loop_id, org, contact_name, email, source, consent_basis, status, notes, created_at, updated_at)
VALUES
  ('prospect-q', 'local', 'loop-growth-local', 'Acme Local', 'Queue Contact', 'queue@example.test', 'seed', 'existing_relationship', 'queued', 'Local queued prospect', datetime('now','-4 days'), datetime('now','-4 days')),
  ('prospect-d', 'local', 'loop-growth-local', 'Beta Local', 'Draft Contact', 'draft@example.test', 'seed', 'consent', 'drafted', 'Local drafted prospect', datetime('now','-3 days'), datetime('now','-3 days')),
  ('prospect-s', 'local', 'loop-growth-local', 'Cyan Local', 'Sent Contact', 'sent@example.test', 'seed', 'consent', 'sent', 'Local sent prospect', datetime('now','-2 days'), datetime('now','-2 days')),
  ('prospect-r', 'local', 'loop-growth-local', 'Delta Local', 'Reply Contact', 'reply@example.test', 'seed', 'consent', 'replied', 'Local replied prospect', datetime('now','-1 day'), datetime('now','-1 day'));

INSERT OR IGNORE INTO metric_points (id, tenant_id, metric_key, value, occurred_at, source, created_at)
VALUES
  ('mp-local-1', 'local', 'growth.leads', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 days'), 'local-seed', datetime('now')),
  ('mp-local-2', 'local', 'growth.leads', 2, strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days'), 'local-seed', datetime('now')),
  ('mp-local-3', 'local', 'growth.leads', 4, strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day'), 'local-seed', datetime('now'));

INSERT OR REPLACE INTO cc_spend_daily (date, agent, model_family, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, usd_micro, turns, updated_at)
VALUES
  (date('now','-1 day'), 'agent-hermes', 'sonnet', 120000, 35000, 12000, 45000, 685000, 8, datetime('now')),
  (date('now'), 'agent-hermes', 'opus', 90000, 22000, 5000, 20000, 2100000, 5, datetime('now')),
  (date('now'), 'agent-growth', 'haiku', 45000, 15000, 0, 9000, 180000, 4, datetime('now'));

INSERT OR REPLACE INTO execution_meter (id, window_key, count, tokens, window_start, cost_micro_usd)
VALUES
  ('meter-hermes-today', 'local:agent-hermes:' || date('now'), 2, 14000, datetime('now','start of day'), 86000),
  ('meter-growth-today', 'local:agent-growth:' || date('now'), 1, 4000, datetime('now','start of day'), 12000);

INSERT OR REPLACE INTO flights (
  id, tenant, agent, goal, status, trigger_source, gate_verdict, gate_reason,
  score, budget_micro_usd, cost_micro_usd, next_run_at, created_at, started_at, ended_at, meta
) VALUES
  ('flight-running-local', 'local', 'agent-hermes', 'Run local browser smoke', 'running', 'manual', 'go', '', 0.82, 1000000, 220000, NULL, unixepoch('now','-30 minutes') * 1000, unixepoch('now','-29 minutes') * 1000, NULL, '{"source":"seed"}'),
  ('flight-sleeping-local', 'local', 'agent-growth', 'Wait for next local check', 'sleeping', 'schedule', 'go', '', 0.74, 500000, 160000, (unixepoch('now','+30 minutes') * 1000), unixepoch('now','-2 hours') * 1000, unixepoch('now','-2 hours') * 1000, NULL, '{"source":"seed"}'),
  ('flight-landed-local', 'local', 'agent-hermes', 'Complete local seed', 'landed', 'manual', 'go', '', 0.91, 750000, 330000, NULL, unixepoch('now','-5 hours') * 1000, unixepoch('now','-5 hours') * 1000, unixepoch('now','-4 hours') * 1000, '{"source":"seed"}');

INSERT OR REPLACE INTO journeys (id, tenant, agent, project, goal, status, gate, departed_at, eta, arrived_at, created_at, updated_at)
VALUES
  ('journey-local-1', 'local', 'agent-hermes', 'mupot', 'Smoke every dashboard page', 'departed', 'PR #local', unixepoch('now','-20 minutes') * 1000, unixepoch('now','+20 minutes') * 1000, NULL, unixepoch('now','-25 minutes') * 1000, unixepoch('now','-20 minutes') * 1000),
  ('journey-local-2', 'local', 'agent-growth', 'digid', 'Hold local growth checks', 'boarding', '', NULL, unixepoch('now','+50 minutes') * 1000, NULL, unixepoch('now','-10 minutes') * 1000, unixepoch('now','-10 minutes') * 1000);

INSERT OR REPLACE INTO fleet_agents (
  agent_id, tenant, display, runtime, squads, lifecycle, provider_contract, status,
  reported_by, last_reported_at, updated_at, agent_type, member_id
) VALUES
  ('hermes-local', 'local', 'Hermes Local Relay', 'hermes-cron', '["growth"]', 'always_on', NULL, 'running', 'local-seed', datetime('now'), datetime('now'), 'comms', 'mbr-hermes-user'),
  ('codex-local', 'local', 'Codex Local Builder', 'codex', '["growth"]', 'on_demand', NULL, 'stopped', 'local-seed', datetime('now','-2 hours'), datetime('now','-2 hours'), 'builder', NULL);

INSERT OR REPLACE INTO presence (tenant, member_id, display_name, source, label, first_seen_at, last_seen_at, agent_id)
VALUES ('local', 'mbr-hermes-user', 'Hermes Test Operator', 'hermes', 'local relay', datetime('now','-1 hour'), datetime('now'), 'agent-hermes');

INSERT OR REPLACE INTO connectors (
  id, tenant, type, label, encrypted_secret, meta, scope_type, scope_id, created_by, created_at, revoked_at
) VALUES (
  'conn-local-github', 'local', 'github_app', 'Local GitHub App placeholder', 'local-ciphertext',
  '{"plan_tier":"team"}', 'pot', NULL, 'usr-local-owner', datetime('now','-1 hour'), NULL
);

INSERT OR IGNORE INTO connector_audit (id, connector_id, tenant, action, actor_id, detail, recorded_at)
VALUES ('ca-local-github', 'conn-local-github', 'local', 'add', 'usr-local-owner', '{"seed":true}', datetime('now','-1 hour'));

INSERT OR REPLACE INTO github_installations (tenant, installation_id, account_login, installed_at, updated_at)
VALUES ('local', '123456789', 'Mumega-com', datetime('now','-1 hour'), datetime('now','-1 hour'));
