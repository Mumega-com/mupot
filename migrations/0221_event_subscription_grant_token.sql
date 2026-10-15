-- 0221_event_subscription_grant_token.sql — MCP Events for ATTACHED agents (mupot W2): a subscription made through an attachment stores the
-- attachment's own token (so its liveness follows the attachment), but the HUMAN's connector grant that authorised the subscribe must also stay
-- live for the subscription's whole life: revoking the grant has to stop the wake. NULL for every pre-existing subscription (agent-bound
-- consent / workspace tokens), which never use it.
ALTER TABLE event_subscriptions ADD COLUMN grant_token_id TEXT;
