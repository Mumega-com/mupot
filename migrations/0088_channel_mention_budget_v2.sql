-- 0088_channel_mention_budget_v2.sql
-- mupot P0 addressing fix (mumega-com#722 follow-up) + rate-wall repair
-- (flight-20260809-mupot-deploy-unblock, Loom's binding ruling).
--
-- channel_mention_budget (0082) keys the 10/hour central-command rate wall on
-- (tenant, agent_slug, hour_bucket) alone -- no sender dimension. That is a
-- cross-sender DoS once dispatch actually delivers: ANY linked member can burn
-- one SPECIFIC recipient's hourly budget and lock out every OTHER sender's
-- legitimate dispatch to that same agent for the rest of the hour -- including
-- the directive sender (Hadi).
--
-- A first attempt at fixing this (mumega-com#722 follow-up) charged THIS table
-- IN ADDITION to the 0082 global per-slug wall, not instead of it. That did not
-- fix the DoS: an extra, narrower constraint cannot lift a lockout an earlier,
-- wider wall already imposed. Sender A spending 10 mentions on @X still tripped
-- the 0082 global-per-slug wall for sender B's first mention to @X.
--
-- The repair (this migration's actual charge site, src/channels/index.ts
-- dispatchMention) makes THIS table -- keyed per (tenant, from_member, agent_id,
-- hour_bucket), i.e. per SENDER per RESOLVED RECIPIENT UUID -- the ONLY
-- enforced central-command mention wall. The 0082 global per-slug wall is no
-- longer charged at all; per Loom's ruling, it is removed from enforcement
-- outright rather than replaced with some other aggregate ceiling (a
-- global-aggregate cap is a separate authorization decision, not made here).
--
-- Additive only (D1 rule: never blind-apply, never drop a table something may
-- still be reading -- see the CLAUDE.md 0020-DROP landmine note). channel_mention
-- _budget (0082) is left exactly as it was -- orphaned, not dropped; safe to
-- remove in a later cleanup migration once nothing references it.
CREATE TABLE IF NOT EXISTS channel_mention_budget_v2 (
  tenant      TEXT NOT NULL DEFAULT 'mumega',
  from_member TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  hour_bucket TEXT NOT NULL,
  count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant, from_member, agent_id, hour_bucket)
);
