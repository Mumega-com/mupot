-- 0226 — an agent-connection receipt may not exist without the token it names (mupot#1961).
--
-- provisionAgentConnection commits access rows, an immutable receipt and the request's
-- credential_issued flip in ONE batch with the guarded token statements. Those token statements
-- are conditional (they land only while the agent is active); the receipt, access and request
-- statements are not. Deactivating the agent between the service's read and the batch left a
-- receipt that names a token_id that does not exist, access rows for an agent that never got a
-- credential, and (on replace) a revoked prior token with no successor.
--
-- D1 rolls a batch back only on ERROR, never on a zero-row write. This trigger turns "the guarded
-- token did not land" into an error at the receipt insert, which aborts and rolls back the whole
-- batch (membership, capability, weld, request flip, and the replace trigger's revocation).
-- The existing agent_connection_receipt_replaces_live_token trigger fires in the same statement; any
-- abort undoes its UPDATE too.
CREATE TRIGGER IF NOT EXISTS agent_connection_receipt_requires_token
BEFORE INSERT ON agent_connection_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM member_tokens
   WHERE id = NEW.token_id
     AND tenant = NEW.tenant
     AND agent_id = NEW.agent_id
)
BEGIN
  SELECT RAISE(ABORT, 'receipt_token_missing');
END;
