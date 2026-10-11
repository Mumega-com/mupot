// Leaf module (no imports): the JSON schema of a harness-stamped human_origin. It lives here, not in
// src/mcp/index.ts, so src/mcp/elevation-decide.ts can read it at module-init time without a runtime
// import cycle through index.ts (an esbuild bundle would initialise elevation-decide first and see
// `undefined`). index.ts re-exports it for existing importers.

const STRING_SCHEMA = { type: 'string' }

export const HUMAN_ORIGIN_SCHEMA = {
  type: 'object',
  properties: {
    channel: STRING_SCHEMA,
    user_id: STRING_SCHEMA,
    chat_id: STRING_SCHEMA,
    message_id: STRING_SCHEMA,
    // message_at is REQUIRED, not optional (mupot#1424 addendum): freshness
    // cannot be checked against a timestamp the caller may omit. See
    // src/im/origin-verdict.ts's FRESHNESS_MAX_AGE_MS/FRESHNESS_MAX_FUTURE_MS.
    message_at: STRING_SCHEMA,
    // text is REQUIRED (round 4 addendum, plugin gate P2-1): the human's own
    // message, so mupot can bind the origin's INTENT server-side — the
    // target task id must appear in it (full id, or an 8+ hex-char prefix of
    // its own leading hex characters) or the stamp does not apply to this
    // task at all (`task_not_named`). See taskNamedInText in
    // src/im/origin-verdict.ts.
    text: STRING_SCHEMA,
  },
  required: ['channel', 'user_id', 'chat_id', 'message_id', 'message_at', 'text'],
  additionalProperties: false,
}
