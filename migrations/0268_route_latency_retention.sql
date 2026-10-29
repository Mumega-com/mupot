-- One fixed authenticated route. No user, query, URL, header or credential fields.
CREATE TABLE route_latency_requests (
  tenant TEXT NOT NULL,
  route TEXT NOT NULL CHECK (route = 'GET /dashboard/kanban'),
  bucket_ms INTEGER NOT NULL CHECK (bucket_ms >= 0),
  total_requests INTEGER NOT NULL CHECK (total_requests > 0),
  PRIMARY KEY (tenant, route, bucket_ms)
);

CREATE TABLE route_latency_samples (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  route TEXT NOT NULL CHECK (route = 'GET /dashboard/kanban'),
  observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms >= 0),
  duration_ms REAL NOT NULL CHECK (duration_ms >= 0)
);
CREATE INDEX route_latency_samples_window
  ON route_latency_samples (tenant, route, observed_at_ms DESC, id DESC);

-- Collection-start metadata survives sample expiry; it contains no request data.
CREATE TABLE route_latency_collection (
  tenant TEXT NOT NULL,
  route TEXT NOT NULL CHECK (route = 'GET /dashboard/kanban'),
  started_at_ms INTEGER NOT NULL,
  PRIMARY KEY (tenant, route)
);
