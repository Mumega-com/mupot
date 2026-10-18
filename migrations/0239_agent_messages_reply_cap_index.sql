-- Reply-exception cap (#2041): the atomic cap counts a replier's messages to one recipient keyed
-- on in_reply_to. Without this the count scans the recipient's whole history.
CREATE INDEX IF NOT EXISTS idx_agent_messages_reply_cap
  ON agent_messages(tenant, from_agent, to_agent, in_reply_to)
  WHERE in_reply_to IS NOT NULL;
