ALTER TABLE agent_messages
  ADD COLUMN body_length INTEGER
  CHECK (body_length IS NULL OR body_length >= 0);

ALTER TABLE agent_messages
  ADD COLUMN checksum_sha256 TEXT
  CHECK (
    checksum_sha256 IS NULL OR (
      length(checksum_sha256) = 64
      AND checksum_sha256 = lower(checksum_sha256)
      AND checksum_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  );

CREATE TRIGGER agent_messages_integrity_baseline_immutable
BEFORE UPDATE OF body_length, checksum_sha256 ON agent_messages
WHEN OLD.body_length IS NOT NEW.body_length
  OR OLD.checksum_sha256 IS NOT NEW.checksum_sha256
BEGIN
  SELECT RAISE(ABORT, 'agent message integrity baseline is immutable');
END;
