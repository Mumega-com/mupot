-- 0235_boot_observed_facts.sql — boot is the single writer of OBSERVED facts.
--
-- fleet_agents already carries runtime, model and host. Three observed facts had no
-- column: HOW the caller connected (server-derived, never from args), WHEN it last
-- booted, and the canonical hint for the raw runtime string the caller reported.
-- presence gets the same canonical hint for the raw check_in harness.
--
-- Raw values stay as reported; *_canonical is a display/filter hint ('other' when the
-- value matches no known harness), never a gate. Additive only: ADD COLUMN with a
-- default, no backfill, no table recreate. Declared fields (owner, role, purpose, name)
-- are untouched.

ALTER TABLE fleet_agents ADD COLUMN connection_kind TEXT NOT NULL DEFAULT '';
ALTER TABLE fleet_agents ADD COLUMN last_boot_at TEXT;
ALTER TABLE fleet_agents ADD COLUMN runtime_canonical TEXT NOT NULL DEFAULT '';
ALTER TABLE presence ADD COLUMN harness_canonical TEXT NOT NULL DEFAULT '';
