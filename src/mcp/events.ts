// src/mcp/events.ts — MCP Events (protocol 2026-07-28), PR 1 of 2 (mupot#1618).
//
// SCOPE OF THIS FILE: protocol negotiation, the `server/discover` result, and the static
// `events/list` catalogue. There is NO subscribe/delivery machinery here: events/subscribe and
// events/unsubscribe are registered as method names only and refuse. Nothing in this module
// reads or writes D1, KV, queues, or makes a fetch.
//
// Spec: https://developers.openai.com/plugins/build/mcp-events
//
// EVERYTHING here is behind EVENTS_ENABLED (default OFF): version negotiation, `server/discover`,
// and events/*. With the flag off, every request (including `initialize` asking for exactly
// 2026-07-28, and `server/discover`) is byte-identical to origin/main, so merging changes
// nothing for the live ChatGPT connector.

import type { Env } from '../types'

/** The legacy version `initialize` has always answered with. Every client that does not ask
 *  for EVENTS_PROTOCOL_VERSION keeps getting exactly this (byte-identical response). */
export const LEGACY_PROTOCOL_VERSION = '2025-06-18'

/** MCP Events protocol version (draft) — spec `server/discover` example. */
export const EVENTS_PROTOCOL_VERSION = '2026-07-28'

/** Newest first, as the spec example lists them. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  EVENTS_PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSION,
]

/** Enabled ONLY when EVENTS_ENABLED is exactly the string "true" ("TRUE", "1", "", unset: off). */
export function isEventsEnabled(env: Pick<Env, 'EVENTS_ENABLED'>): boolean {
  return env.EVENTS_ENABLED === 'true'
}

/**
 * Version negotiation. Flag OFF: always the legacy version (the pre-change behaviour, whatever the
 * client asked). Flag ON: ONLY an exact, case- and whitespace-sensitive request for 2026-07-28 gets
 * 2026-07-28; anything else (absent, non-string, unknown, ' 2026-07-28', older) keeps the legacy
 * version, so no existing client can be moved by this change.
 */
export function negotiateProtocolVersion(params: unknown, enabled: boolean): string {
  if (enabled && typeof params === 'object' && params !== null && !Array.isArray(params)) {
    const requested = (params as Record<string, unknown>).protocolVersion
    if (requested === EVENTS_PROTOCOL_VERSION) return EVENTS_PROTOCOL_VERSION
  }
  return LEGACY_PROTOCOL_VERSION
}

/** Capabilities for a 2026-07-28 response. Only ever called with the flag on. */
export function eventsProtocolCapabilities(): Record<string, unknown> {
  return { tools: {}, events: {} }
}

/** `server/discover` result (spec: resultType, supportedVersions, capabilities). Flag-on only. */
export function serverDiscoverResult(): Record<string, unknown> {
  return {
    resultType: 'complete',
    supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
    capabilities: eventsProtocolCapabilities(),
  }
}

/** The events/* method names this build registers. */
export const EVENTS_METHODS: ReadonlySet<string> = new Set([
  'events/list',
  'events/subscribe',
  'events/unsubscribe',
])

export interface EventDefinition {
  name: string
  description: string
  delivery: ['webhook']
  inputSchema: Record<string, unknown>
  payloadSchema: Record<string, unknown>
}

// The principal's own inbox/attention queue is implicit from the authenticated principal;
// a subscription takes NO arguments, so there is nothing to point at someone else's queue.
function noArgs(): Record<string, unknown> {
  return { type: 'object', properties: {}, additionalProperties: false }
}

// How to read the message an event points at (verified against src/mcp/index.ts toolInbox and
// src/agents/messages.ts readAgentInboxForReader): `inbox` is own-inbox scoped (to_agent = the
// bound agent), `since_seq` is EXCLUSIVE (seq > since_seq) and requires peek=true, and a peek
// returns only rows that are still UNREAD and visible to the caller's seat partition.
// `message_get` is sender-scoped (rows the caller WROTE) and can NOT read an incoming delivery,
// so it must never appear here. Hence `read_after_seq = seq - 1` (never negative).
export const MESSAGE_READ_INSTRUCTION =
  'inbox {"peek":true,"since_seq":<read_after_seq>,"limit":1}'

const MESSAGE_CREATED: EventDefinition = {
  name: 'message.created',
  description:
    "A new message was delivered to the authenticated agent's own inbox. The inbox is implied by the " +
    'authenticated principal; there are no filter arguments. The payload is a body-free summary. To read ' +
    `the message, call the inbox tool exactly as ${MESSAGE_READ_INSTRUCTION} using the payload's ` +
    'read_after_seq (since_seq is exclusive, so read_after_seq is seq - 1); the first returned message ' +
    'is the one that triggered the event. inbox reads only your own inbox and, with peek, returns only ' +
    'messages that are still unread, so a message already consumed by another reader is no longer returned. ' +
    'Messages the agent sent itself do not produce this event.',
  delivery: ['webhook'],
  inputSchema: noArgs(),
  payloadSchema: {
    type: 'object',
    properties: {
      message_id: { type: 'string', description: 'Message id (identification only; not a read handle).' },
      seq: { type: 'integer', minimum: 1, description: 'Inbox sequence number of the triggering message.' },
      read_after_seq: {
        type: 'integer',
        minimum: 0,
        description:
          'seq - 1 (never negative). Pass as since_seq to ' + MESSAGE_READ_INSTRUCTION +
          ' (since_seq is exclusive); the first returned message is the triggering one.',
      },
      kind: { type: 'string', description: 'Message kind (e.g. message, task, request).' },
      request_id: { type: ['string', 'null'], description: 'Correlation id when the sender set one, else null.' },
    },
    required: ['message_id', 'seq', 'read_after_seq', 'kind', 'request_id'],
    additionalProperties: false,
  },
}

/** The `read_after_seq` a delivery must carry for a given inbox seq. PR 2's delivery MUST use this. */
export function readAfterSeq(seq: number): number {
  return Math.max(0, seq - 1)
}

/**
 * v1 advertises ONLY message.created (the #1618 contract). To add an event later: add an entry here
 * naming the tool a subscriber reads it with; the catalogue then lists it only for a principal who
 * passes that tool's own floor.
 */
const CATALOGUE: readonly { def: EventDefinition; readTool: string }[] = [
  { def: MESSAGE_CREATED, readTool: 'inbox' },
]

/**
 * The catalogue for a principal.
 *  - `bound`: the session is bound to an agent (auth.boundAgentId). An unbound / zero-capability
 *    directory session has no inbox and gets an EMPTY catalogue (not a filtered full one).
 *  - `mayCallTool`: whether the principal passes the named read tool's OWN floor. The caller (index.ts)
 *    derives it from the live tool registry entry, so the catalogue can never advertise an event whose
 *    read tool the principal could not call, and cannot drift from the tool's declared minimum.
 */
export function eventCatalogue(opts: { bound: boolean; mayCallTool: (toolName: string) => boolean }): EventDefinition[] {
  if (!opts.bound) return []
  return CATALOGUE.filter((e) => opts.mayCallTool(e.readTool)).map((e) => structuredClone(e.def))
}
