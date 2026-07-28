-- 0072_workflow_circuits.sql — workflow-circuits addon: a deterministic
-- workflow-graph engine. "Circuit schematic," not a router: execution state
-- propagates only when a node's declared gate rule over its typed input wires
-- is satisfied. Every wire and rule is declared at define_circuit time, not
-- decided at runtime by a model (see docs/decisions -- "gates not routers").
--
-- Modeled on migrations/0057_project_links.sql's proportionality, NOT on
-- 0050_addons.sql's append-only-receipt ceremony -- that ceremony belongs to
-- the generic addon INSTALL lifecycle (addon_installations / addon_receipts,
-- shared by every addon via src/addons/service.ts) and is reused as-is by
-- this addon's manifest (src/addons/workflow-circuits/manifest.ts). These
-- tables are this addon's OWN domain data, same layer project_links /
-- project_link_deliveries / project_link_receipts occupy for project-link.

CREATE TABLE IF NOT EXISTS workflow_circuits (
  id                  TEXT NOT NULL PRIMARY KEY,
  tenant              TEXT NOT NULL,
  key                 TEXT NOT NULL,
  name                TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'defined' CHECK (status IN ('defined','archived')),
  definition_sha256   TEXT NOT NULL CHECK (
    length(definition_sha256) = 64
    AND definition_sha256 = lower(definition_sha256)
    AND definition_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_by          TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  archived_at         TEXT,
  UNIQUE (tenant, key)
);

CREATE TABLE IF NOT EXISTS workflow_circuit_nodes (
  circuit_id       TEXT NOT NULL REFERENCES workflow_circuits(id) ON DELETE RESTRICT,
  id               TEXT NOT NULL,
  tenant           TEXT NOT NULL,
  type             TEXT NOT NULL CHECK (length(type) BETWEEN 1 AND 64),
  done_state       TEXT NOT NULL DEFAULT 'pending' CHECK (
    done_state IN ('pending','active','done','blocked','failed','timeout','degraded')
  ),
  gate_rule        TEXT NOT NULL CHECK (gate_rule IN ('AND','OR')),
  customer_facing  INTEGER NOT NULL DEFAULT 0 CHECK (customer_facing IN (0,1)),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (circuit_id, id)
);

CREATE INDEX IF NOT EXISTS idx_workflow_circuit_nodes_tenant
  ON workflow_circuit_nodes (tenant, circuit_id);

-- All edges are typed, not generic arrows. 'fallback' is new this flight — the
-- explicit "what happens if the source fails/times out" wire (aviation
-- checklist: abnormal procedures pre-wired, not improvised at failure time).
CREATE TABLE IF NOT EXISTS workflow_circuit_edges (
  id               TEXT NOT NULL PRIMARY KEY,
  circuit_id       TEXT NOT NULL REFERENCES workflow_circuits(id) ON DELETE RESTRICT,
  tenant           TEXT NOT NULL,
  type             TEXT NOT NULL CHECK (type IN ('dependency','gate','trigger','fallback')),
  source_node_id   TEXT NOT NULL,
  target_node_id   TEXT NOT NULL,
  -- Meaningful only for type='gate': the explicit human/agent approval signal
  -- this edge's satisfaction depends on (see workflow-circuits/service.ts
  -- approveGateEdge). NULL until approved; both set together or neither.
  approved_by      TEXT,
  approved_at      TEXT,
  created_at       TEXT NOT NULL,
  CHECK (source_node_id <> target_node_id),
  CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  FOREIGN KEY (circuit_id, source_node_id)
    REFERENCES workflow_circuit_nodes (circuit_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (circuit_id, target_node_id)
    REFERENCES workflow_circuit_nodes (circuit_id, id) ON DELETE RESTRICT
);

-- No duplicate identical wire (same type between the same ordered pair).
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_circuit_edges_unique
  ON workflow_circuit_edges (circuit_id, type, source_node_id, target_node_id);

CREATE INDEX IF NOT EXISTS idx_workflow_circuit_edges_source
  ON workflow_circuit_edges (circuit_id, source_node_id, type);

CREATE INDEX IF NOT EXISTS idx_workflow_circuit_edges_target
  ON workflow_circuit_edges (circuit_id, target_node_id, type);

-- Append-only audit trail of every advance_node call (including cascaded
-- trigger/fallback auto-advances). cascade_source_node_id is non-null when
-- this row was produced automatically by a trigger/fallback wire firing
-- rather than a direct advance_node call.
CREATE TABLE IF NOT EXISTS workflow_circuit_node_events (
  id                       TEXT NOT NULL PRIMARY KEY,
  tenant                   TEXT NOT NULL,
  circuit_id               TEXT NOT NULL REFERENCES workflow_circuits(id) ON DELETE RESTRICT,
  node_id                  TEXT NOT NULL,
  previous_state           TEXT NOT NULL CHECK (
    previous_state IN ('pending','active','done','blocked','failed','timeout','degraded')
  ),
  next_state               TEXT NOT NULL CHECK (
    next_state IN ('pending','active','done','blocked','failed','timeout','degraded')
  ),
  actor_id                 TEXT NOT NULL,
  cascade_source_node_id   TEXT,
  cascade_edge_type        TEXT CHECK (cascade_edge_type IS NULL OR cascade_edge_type IN ('trigger','fallback')),
  reason                   TEXT,
  created_at               TEXT NOT NULL,
  FOREIGN KEY (circuit_id, node_id)
    REFERENCES workflow_circuit_nodes (circuit_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_workflow_circuit_node_events_node
  ON workflow_circuit_node_events (tenant, circuit_id, node_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS workflow_circuit_node_events_no_update
  BEFORE UPDATE ON workflow_circuit_node_events
BEGIN
  SELECT RAISE(ABORT, 'workflow circuit node events are append-only: UPDATE is forbidden');
END;

CREATE TRIGGER IF NOT EXISTS workflow_circuit_node_events_no_delete
  BEFORE DELETE ON workflow_circuit_node_events
BEGIN
  SELECT RAISE(ABORT, 'workflow circuit node events are append-only: DELETE is forbidden');
END;
