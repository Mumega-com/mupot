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

-- Local-only Mumega portfolio showcase. Projects are operational context inside
-- this pot; they are not production defaults or migration-owned tenant data.
INSERT INTO projects (
  id, slug, name, description, goal, status, parent_project_id, target_date, created_at, updated_at
) VALUES
  (
    'project-mumega-products', 'mumega-products', 'Mumega Products',
    'Products developed and operated by the Mumega pot.',
    'Grow a coherent portfolio of independently useful products.',
    'active', NULL, NULL, datetime('now'), datetime('now')
  ),
  (
    'project-marketing-infrastructure', 'marketing-infrastructure', 'Marketing Infrastructure',
    'Shared marketing and conversion infrastructure for the Mumega portfolio.',
    'Make measurable marketing operations reusable across products.',
    'active', NULL, NULL, datetime('now'), datetime('now')
  )
ON CONFLICT(id) DO UPDATE SET
  slug = excluded.slug,
  name = excluded.name,
  description = excluded.description,
  goal = excluded.goal,
  status = excluded.status,
  parent_project_id = excluded.parent_project_id,
  target_date = excluded.target_date,
  updated_at = excluded.updated_at;

INSERT INTO projects (
  id, slug, name, description, goal, status, parent_project_id, target_date, created_at, updated_at
) VALUES
  (
    'project-inkwell', 'inkwell', 'Inkwell',
    'Mumega documentation and knowledge product.',
    'Turn verified work into durable, reusable knowledge.',
    'active', 'project-mumega-products', NULL, datetime('now'), datetime('now')
  ),
  (
    'project-mirror', 'mirror', 'Mirror',
    'Mumega reflection and evidence product.',
    'Make product state and evidence legible to collaborators.',
    'active', 'project-mumega-products', NULL, datetime('now'), datetime('now')
  ),
  (
    'project-sos', 'sos', 'SOS',
    'A separate Mumega product represented as portfolio context only.',
    'Coordinate its own product outcomes without becoming a Mupot dependency.',
    'active', 'project-mumega-products', NULL, datetime('now'), datetime('now')
  ),
  (
    'project-mupot', 'mupot', 'Mupot',
    'The project-centered agentic workspace and control plane.',
    'Run stateful human and AI squads through governed, attributable work.',
    'active', 'project-mumega-products', NULL, datetime('now'), datetime('now')
  ),
  (
    'project-mcpwp', 'mcpwp', 'MCPWP',
    'Provider-neutral WordPress integration work.',
    'Connect measurable website work without owning project identity.',
    'active', 'project-marketing-infrastructure', NULL, datetime('now'), datetime('now')
  ),
  (
    'project-mumcp', 'mumcp', 'MumCP',
    'Shared MCP integration infrastructure.',
    'Expose governed marketing capabilities through portable adapters.',
    'active', 'project-marketing-infrastructure', NULL, datetime('now'), datetime('now')
  )
ON CONFLICT(id) DO UPDATE SET
  slug = excluded.slug,
  name = excluded.name,
  description = excluded.description,
  goal = excluded.goal,
  status = excluded.status,
  parent_project_id = excluded.parent_project_id,
  target_date = excluded.target_date,
  updated_at = excluded.updated_at;

INSERT INTO project_squad_access (project_id, squad_id, access_level, granted_at)
VALUES
  ('project-mumega-products', 'sq-growth', 'write', datetime('now')),
  ('project-marketing-infrastructure', 'sq-growth', 'write', datetime('now')),
  ('project-inkwell', 'sq-growth', 'write', datetime('now')),
  ('project-mirror', 'sq-growth', 'write', datetime('now')),
  ('project-sos', 'sq-growth', 'write', datetime('now')),
  ('project-mupot', 'sq-growth', 'write', datetime('now')),
  ('project-mcpwp', 'sq-growth', 'write', datetime('now')),
  ('project-mumcp', 'sq-growth', 'write', datetime('now'))
ON CONFLICT(project_id, squad_id) DO UPDATE SET
  access_level = excluded.access_level;

INSERT INTO agents (
  id, squad_id, slug, name, role, model, status, created_at, okr, kpi_target,
  kpi_progress, effort, autonomy, budget_cap_cents, budget_window
) VALUES
  ('agent-hermes', 'sq-growth', 'hermes', 'Hermes Local', 'IM control and local smoke', '@cf/meta/llama-3.3', 'active', datetime('now'), NULL, 'local smoke passing', 0.66, 'standard', 'draft', 1500, 'week'),
  ('agent-growth', 'sq-growth', 'growth-lead', 'Growth Lead Local', 'Growth operator', '@cf/meta/llama-3.3', 'paused', datetime('now'), 'Improve local pipeline confidence', '3 smoke checks green', 0.45, 'low', 'suggest', 500, 'day'),
  ('agent-conformance', 'sq-growth', 'runtime-conformance', 'Runtime Conformance Local', 'Local signed runtime adapter fixture', 'local-fixture', 'active', datetime('now'), 'Prove runtime-adapter/v1 over HTTP', 'signed attach, inbox, and detach pass', 0.1, 'low', 'draft', 100, 'day'),
  ('agent-conformance-sender', 'sq-growth', 'runtime-conformance-sender', 'Runtime Conformance Sender', 'Local sender fixture for runtime conformance', 'local-fixture', 'active', datetime('now'), 'Seed conformance inbox messages', 'bearer send succeeds', 0.1, 'low', 'draft', 100, 'day')
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
  ('memship-growth-growth', 'agent-growth', 'sq-growth', 'member'),
  ('memship-conformance-growth', 'agent-conformance', 'sq-growth', 'member'),
  ('memship-conformance-sender-growth', 'agent-conformance-sender', 'sq-growth', 'member')
ON CONFLICT(id) DO UPDATE SET capability = excluded.capability;

INSERT INTO members (id, email, display_name, telegram_chat_id, status, created_at, tenant)
VALUES
  ('mbr-hermes-user', 'hermes@mupot.test', 'Hermes Test Operator', '123456789', 'active', datetime('now'), 'local'),
  ('mbr-local-admin', 'local-admin@mupot.test', 'Local Admin', NULL, 'active', datetime('now'), 'local'),
  ('mbr-conformance-runtime', 'runtime-conformance@mupot.test', 'Runtime Conformance Local', NULL, 'active', datetime('now'), 'local'),
  ('mbr-conformance-sender', 'runtime-conformance-sender@mupot.test', 'Runtime Conformance Sender', NULL, 'active', datetime('now'), 'local')
ON CONFLICT(id) DO UPDATE SET
  email = excluded.email,
  display_name = excluded.display_name,
  telegram_chat_id = excluded.telegram_chat_id,
  status = excluded.status,
  tenant = excluded.tenant;

INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
VALUES
  ('cap-hermes-org-admin', 'mbr-hermes-user', 'org', NULL, 'owner'),
  ('cap-admin-org-owner', 'mbr-local-admin', 'org', NULL, 'owner'),
  ('cap-conformance-runtime-member', 'mbr-conformance-runtime', 'squad', 'sq-growth', 'member'),
  ('cap-conformance-sender-member', 'mbr-conformance-sender', 'squad', 'sq-growth', 'member')
ON CONFLICT(id) DO UPDATE SET capability = excluded.capability;

-- Local-only runtime adapter conformance fixtures. The private key matching this
-- public key is embedded in scripts/local-runtime-conformance.mjs and is not a
-- production credential.
INSERT INTO agent_keys (tenant, agent_id, pubkey, algo, member_id, created_at)
VALUES ('local', 'agent-conformance', '5hhsUxlkZWNACkMQjUFNIO1-e4bbFtTaLUd7_5L7sdU', 'Ed25519', 'mbr-conformance-runtime', unixepoch('now'))
ON CONFLICT(tenant, agent_id) DO UPDATE SET
  pubkey = excluded.pubkey,
  algo = excluded.algo,
  member_id = excluded.member_id,
  created_at = excluded.created_at;

-- The conformance runtime is the sole local consumer for this signed inbox.
INSERT INTO agent_inbox_fences (
  tenant, agent_id, mode, generation, key_fingerprint,
  updated_by_member_id, updated_at, reason
) VALUES (
  'local', 'agent-conformance', 'signed_only', 1,
  '6d4c5cc496a08ce3785f212e13b532c1fc7ee98a905c3d55debb48b1d13f690e',
  'mbr-conformance-runtime', datetime('now'), 'local runtime conformance signed inbox'
)
ON CONFLICT(tenant, agent_id) DO UPDATE SET
  mode = excluded.mode,
  generation = excluded.generation,
  key_fingerprint = excluded.key_fingerprint,
  updated_by_member_id = excluded.updated_by_member_id,
  updated_at = excluded.updated_at,
  reason = excluded.reason;

INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, revoked_at, agent_id, tenant)
VALUES (
  'tok-conformance-sender',
  'mbr-conformance-sender',
  'fd112c91b89c533d421777fcdfb826e3c6cd620da1c2094d407c28a9627f8f17',
  'local runtime conformance sender',
  'workspace',
  datetime('now'),
  NULL,
  'agent-conformance-sender',
  'local'
)
ON CONFLICT(id) DO UPDATE SET
  member_id = excluded.member_id,
  token_hash = excluded.token_hash,
  label = excluded.label,
  channel = excluded.channel,
  revoked_at = NULL,
  agent_id = excluded.agent_id,
  tenant = excluded.tenant;

INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, revoked_at, agent_id, tenant)
VALUES (
  'tok-conformance-owner',
  'mbr-local-admin',
  '39b5d3cacafcbe252552358da941aea53d6f39d8ae2ffa8e129f352caf45ef0b',
  'local runtime conformance owner',
  'workspace',
  datetime('now'),
  NULL,
  NULL,
  'local'
)
ON CONFLICT(id) DO UPDATE SET
  member_id = excluded.member_id,
  token_hash = excluded.token_hash,
  label = excluded.label,
  channel = excluded.channel,
  revoked_at = NULL,
  agent_id = excluded.agent_id,
  tenant = excluded.tenant;

INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
VALUES
  ('gg-hermes-local', 'gate:local', 'member', 'mbr-hermes-user', 'usr-local-owner', datetime('now')),
  ('gg-hermes-content', 'content:write', 'member', 'mbr-hermes-user', 'usr-local-owner', datetime('now')),
  ('gg-hermes-budget', 'budget:write', 'member', 'mbr-hermes-user', 'usr-local-owner', datetime('now'))
ON CONFLICT(capability, principal_type, principal_id) DO UPDATE SET granted_by = excluded.granted_by;

INSERT INTO tasks (
  id, squad_id, project_id, title, body, status, assignee_agent_id, github_issue_url,
  created_at, updated_at, result, completed_at, gate_owner, cost_micro_usd,
  workflow_instance_id, done_when
) VALUES
  ('task-open-local', 'sq-growth', NULL, 'Open local smoke task', 'Verify the local dashboard can be reached.', 'open', 'agent-hermes', NULL, datetime('now','-90 minutes'), datetime('now','-80 minutes'), NULL, NULL, NULL, 12000, NULL, 'The local dashboard home returns HTTP 200.'),
  ('task-blocked-local', 'sq-growth', 'project-mupot', 'Resolve local parity blocker', 'The local project situation must show a blocked task before evidence can pass.', 'blocked', 'agent-growth', NULL, datetime('now','-75 minutes'), datetime('now','-45 minutes'), 'Waiting for the dashboard, REST, and MCP situation receipts to agree.', NULL, NULL, 15000, NULL, 'The parity evidence records one shared Project situation.'),
  ('task-progress-local', 'sq-growth', 'project-mupot', 'In-progress local task', 'Exercise the browser crawl against authenticated pages.', 'in_progress', 'agent-hermes', NULL, datetime('now','-70 minutes'), datetime('now','-40 minutes'), NULL, NULL, NULL, 25000, NULL, 'The browser smoke report lists every dashboard page as passed.'),
  ('task-review-local', 'sq-growth', 'project-mupot', 'Review local approval task', 'Seeded row for the approvals and gate queue.', 'review', 'agent-growth', NULL, datetime('now','-55 minutes'), datetime('now','-20 minutes'), 'Draft result ready for approval.', NULL, 'gate:local', 9000, NULL, 'A reviewer approves or rejects this seeded local task.'),
  ('task-done-local', 'sq-growth', 'project-mupot', 'Done local task', 'Seeded completed task for observatory history.', 'done', 'agent-hermes', NULL, datetime('now','-4 hours'), datetime('now','-3 hours'), 'Completed local baseline.', datetime('now','-3 hours'), NULL, 43000, NULL, 'The local seed data is visible in the dashboard.')
ON CONFLICT(id) DO UPDATE SET
  project_id = excluded.project_id,
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
  id, tenant, project_id, agent, goal, status, trigger_source, gate_verdict, gate_reason,
  score, budget_micro_usd, cost_micro_usd, next_run_at, created_at, started_at, ended_at, meta
) VALUES
  ('flight-running-local', 'local', 'project-mupot', 'agent-hermes', 'Run local browser smoke', 'running', 'manual', 'go', '', 0.82, 1000000, 220000, NULL, unixepoch('now','-30 minutes') * 1000, unixepoch('now','-29 minutes') * 1000, NULL, '{"schema":"mupot.flight.meta/v1","goal_id":"goal-local-smoke","objective_id":"objective-browser-smoke","squad_ids":["sq-growth"],"task_ids":["task-progress-local"],"done_when":["The browser smoke report lists every dashboard page as passed."],"artifact_refs":[],"receipt_refs":[],"confidentiality":"internal","publication_target":"none","parent_flight_id":null}'),
  ('flight-sleeping-local', 'local', NULL, 'agent-growth', 'Wait for next local check', 'sleeping', 'schedule', 'go', '', 0.74, 500000, 160000, (unixepoch('now','+30 minutes') * 1000), unixepoch('now','-2 hours') * 1000, unixepoch('now','-2 hours') * 1000, NULL, '{"source":"seed"}'),
  ('flight-landed-local', 'local', 'project-mupot', 'agent-hermes', 'Complete local seed', 'landed', 'manual', 'go', '', 0.91, 750000, 330000, NULL, unixepoch('now','-5 hours') * 1000, unixepoch('now','-5 hours') * 1000, unixepoch('now','-4 hours') * 1000, '{"schema":"mupot.flight.meta/v1","goal_id":"goal-local-seed","objective_id":"objective-project-showcase","squad_ids":["sq-growth"],"task_ids":["task-done-local"],"done_when":["The local seed data is visible in the dashboard."],"artifact_refs":[],"receipt_refs":[],"confidentiality":"internal","publication_target":"none","parent_flight_id":null}');

INSERT OR REPLACE INTO journeys (id, tenant, agent, project, goal, status, gate, departed_at, eta, arrived_at, created_at, updated_at)
VALUES
  ('journey-local-1', 'local', 'agent-hermes', 'mupot', 'Smoke every dashboard page', 'departed', 'PR #local', unixepoch('now','-20 minutes') * 1000, unixepoch('now','+20 minutes') * 1000, NULL, unixepoch('now','-25 minutes') * 1000, unixepoch('now','-20 minutes') * 1000),
  ('journey-local-2', 'local', 'agent-growth', 'digid', 'Hold local growth checks', 'boarding', '', NULL, unixepoch('now','+50 minutes') * 1000, NULL, unixepoch('now','-10 minutes') * 1000, unixepoch('now','-10 minutes') * 1000);

DELETE FROM fleet_agents
WHERE tenant = 'local' AND agent_id IN ('hermes-local', 'codex-local');

INSERT OR REPLACE INTO fleet_agents (
  agent_id, tenant, display, runtime, squads, lifecycle, provider_contract, status,
  reported_by, last_reported_at, updated_at, agent_type, member_id, host
) VALUES
  ('agent-hermes', 'local', 'Hermes Local Relay', 'hermes-cron', '["growth"]', 'always_on', NULL, 'running', 'local-seed', datetime('now'), datetime('now'), 'comms', 'mbr-hermes-user', 'local-hermes-host'),
  ('agent-growth', 'local', 'Growth Lead Local', 'codex', '["growth"]', 'on_demand', NULL, 'stopped', 'local-seed', datetime('now','-2 hours'), datetime('now','-2 hours'), 'builder', NULL, 'local-growth-host'),
  ('agent-conformance', 'local', 'Runtime Conformance Local', 'systemd-user', '["growth"]', 'always_on', NULL, 'running', 'local-seed', datetime('now','-10 minutes'), datetime('now','-10 minutes'), 'generic', 'mbr-conformance-runtime', 'local-conformance-host');

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

-- v0.25 Project Routines local seed (propose-mode smoke)
INSERT OR REPLACE INTO routines (
  id, tenant, project_id, name, objective, status, trigger_kind,
  cron_expression, timezone, next_run_at, overlap_policy, execution_mode,
  responsible_squad_id, preferred_agent_id, budget_micro_usd, max_attempts,
  retry_backoff_seconds, revision, enabled_by, enabled_at, created_by, created_at, updated_at
) VALUES (
  'routine-local-propose', 'local', 'project-mupot', 'Local propose check',
  'Choose one accountable next action for local smoke.',
  'enabled', 'manual', NULL, 'UTC', NULL, 'skip', 'propose',
  'sq-growth', 'agent-hermes', 100000, 3, 300, 1,
  'usr-local-owner', datetime('now'), 'usr-local-owner', datetime('now'), datetime('now')
);

INSERT OR REPLACE INTO routine_runs (
  id, tenant, project_id, routine_id, routine_revision, policy_json, occurrence_key,
  trigger_kind, status, attempt, assigned_agent_id, cost_micro_usd, created_at, updated_at
) VALUES (
  'run-local-waiting', 'local', 'project-mupot', 'routine-local-propose', 1,
  '{"execution_mode":"propose","overlap_policy":"skip","responsible_squad_id":"sq-growth","preferred_agent_id":"agent-hermes","budget_micro_usd":100000,"max_attempts":3,"retry_backoff_seconds":300}',
  'manual:local-smoke', 'manual', 'waiting', 1, 'agent-hermes', 0, datetime('now'), datetime('now')
);

UPDATE routine_runs SET waiting_reason = 'review' WHERE id = 'run-local-waiting';
