-- 0088_channel_mention_budget_v2.sql
-- mupot P0 addressing fix (mumega-com#722 follow-up, WARN-1 from adversarial
-- review on the fix).
--
-- channel_mention_budget (0082) keys the 10/hour central-command rate wall on
-- (tenant, agent_slug, hour_bucket) alone -- no sender dimension. That was
-- harmless while central-command mention dispatch to pot-native agents was
-- broken (every dispatch wrote an unreadable, slug-addressed row -- see the
-- addressing fix this migration ships alongside). Once dispatch actually
-- delivers, the same shape is a DoS: ANY linked member can burn one SPECIFIC
-- recipient's hourly budget and lock out every OTHER sender's legitimate
-- dispatch to that same agent for the rest of the hour -- including the
-- directive sender (Hadi).
--
-- Additive only (D1 rule: never blind-apply, never drop a table something may
-- still be reading -- see the CLAUDE.md 0020-DROP landmine note). This is a NEW
-- table, keyed per (tenant, from_member, agent_id, hour_bucket); the application
-- code (src/channels/index.ts dispatchMention) charges it IN ADDITION to the
-- existing channel_mention_budget global wall, not instead of it. The old table
-- is left exactly as it was -- orphaned, not dropped; safe to remove in a later
-- cleanup migration once nothing references it.
CREATE TABLE IF NOT EXISTS channel_mention_budget_v2 (
  tenant      TEXT NOT NULL DEFAULT 'mumega',
  from_member TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  hour_bucket TEXT NOT NULL,
  count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant, from_member, agent_id, hour_bucket)
);
