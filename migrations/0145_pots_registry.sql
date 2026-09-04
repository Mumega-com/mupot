-- 0145_pots_registry.sql — the `pots` table, which src/pots/checkout.ts has been
-- querying since it was written and which has never existed (mupot#1303).
--
-- checkSlugAvailability runs:
--     SELECT id FROM pots WHERE slug = ?1 LIMIT 1
-- wrapped in `try { ... } catch { /* proceed fail-safe */ }`. With no such table the
-- query throws on EVERY call, the catch swallows it, and the function returns
-- `available: true` for every well-formed non-reserved slug. The "already taken" branch
-- has never executed in production. Measured 2026-09-04:
--
--     GET /api/pots/slug-available?slug=gaf -> {"available":true}
--
-- while `gaf` is a live Worker serving traffic in the mupot-pots dispatch namespace.
--
-- NO SEED HERE, DELIBERATELY. The first version of this migration inserted the one live
-- pot. tests/helpers-migrations.test.ts went red and named it:
--
--     migrations now seed rows: [{"table":"pots","count":1}]
--
-- tests/helpers/migrations.ts caches the finished chain as DDL captured from sqlite_master,
-- which is only sound because no migration seeds data — a property that file documents and
-- guards rather than assumes. A seeding migration would hand every cached test a
-- schema-only database while the first (cache-cold) caller saw the row, so the same code
-- would pass or fail depending on test ordering. The guard caught exactly that.
--
-- The live namespace content is therefore applied as a DATA operation against production
-- D1 at deploy time, not baked into the chain. Read from the Cloudflare API 2026-09-04,
-- the mupot-pots namespace contained exactly one script: gaf, created 2026-08-26T18:40:18Z.
-- Tests seed their own rows.
--
-- This table is also the first brick of the hostname->tenant LOOKUP proposed in mupot#1302.
-- Routing today DERIVES a slug from the hostname by string transform and validates it
-- against nothing; the intended end state is that a request resolves through a record like
-- this one, so an unknown host fails closed instead of being transformed into a guess.
CREATE TABLE IF NOT EXISTS pots (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  worker_script TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',
  -- Provenance of the row, so a future reader can tell a seeded observation from a row
  -- written by provisioning. 'namespace-audit' = read from the live dispatch namespace.
  source        TEXT NOT NULL DEFAULT 'provision',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pots_slug ON pots(slug);
