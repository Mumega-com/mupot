-- mupot#2006 — attribution for writes made through an ATTACHED thread (a seat attached to an existing agent X acts AS X).
-- Nullable, additive: ADD COLUMN only, no backfill (rows written before this migration, and every non-attached write,
-- stay NULL). Values are written from the server-resolved auth context only (auth.seatBinding.attached + the attaching
-- human), never from tool args.
--   attachment_id         = agent_seat_attachments.id the write was made through
--   consenting_member_id  = the human who attached (members.id); counted as AFFILIATED with the submitting agent
-- flight_event_outbox is the flight.landed receipt table (landGovernedFlight).
ALTER TABLE agent_messages ADD COLUMN attachment_id TEXT;
ALTER TABLE agent_messages ADD COLUMN consenting_member_id TEXT;
ALTER TABLE task_result_submissions ADD COLUMN attachment_id TEXT;
ALTER TABLE task_result_submissions ADD COLUMN consenting_member_id TEXT;
ALTER TABLE flight_event_outbox ADD COLUMN attachment_id TEXT;
ALTER TABLE flight_event_outbox ADD COLUMN consenting_member_id TEXT;
