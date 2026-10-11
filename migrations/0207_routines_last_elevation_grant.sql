-- S14: a routine mutation made by an agent under a live elevation grant names
-- that grant on the routine revision it produced (NULL = made by a member).
-- Mirrors projects.created_via_elevation_grant / archive receipts.
ALTER TABLE routines ADD COLUMN last_elevation_grant_id TEXT;
