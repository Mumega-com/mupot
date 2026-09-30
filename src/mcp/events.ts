// src/mcp/events.ts — MCP Events (protocol 2026-07-28), PR 1 of 2 (mupot#1618).
//
// SCOPE OF THIS FILE: protocol negotiation, the `server/discover` result, and the static
// `events/list` catalogue. Pure: nothing in this module reads or writes D1, KV, or queues, or
// makes a fetch. events/subscribe + events/unsubscribe live in ./events-subscriptions.ts,
// callback URL validation / signing / verification in ./events-webhook.ts, delivery in
// ../bus/events-delivery.ts (PR 2, mupot#1618).
//
// Spec: https://developers.openai.com/plugins/build/mcp-events
//
// Everything is behind EVENTS_ENABLED (default OFF). With the flag off, `server/discover`
// does not advertise `events`, every events/* method is method-not-found, and the delivery hook
// in the queue consumer is not called, so shipping this changes nothing observable for the prod
// surface except the (additive) `server/discover` method and 2026-07-28 negotiation for a
// client that explicitly asks for it.

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
 * Version negotiation. ONLY an exact request for 2026-07-28 gets 2026-07-28; anything else
 * (absent, non-string, unknown, 2025-06-18, older) gets the legacy version — the default is
 * deliberately NOT switched, so no existing client can be moved by this change.
 */
export function negotiateProtocolVersion(params: unknown): string {
  if (typeof params === 'object' && params !== null && !Array.isArray(params)) {
    const requested = (params as Record<string, unknown>).protocolVersion
    if (requested === EVENTS_PROTOCOL_VERSION) return EVENTS_PROTOCOL_VERSION
  }
  return LEGACY_PROTOCOL_VERSION
}

/** Capabilities for a NEW-protocol response. `events` only when the flag is on. */
export function eventsProtocolCapabilities(enabled: boolean): Record<string, unknown> {
  return enabled ? { tools: {}, events: {} } : { tools: {} }
}

/** `server/discover` result (spec: resultType, supportedVersions, capabilities). */
export function serverDiscoverResult(enabled: boolean): Record<string, unknown> {
  return {
    resultType: 'complete',
    supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
    capabilities: eventsProtocolCapabilities(enabled),
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

const MESSAGE_CREATED: EventDefinition = {
  name: 'message.created',
  description:
    "A new message was delivered to the authenticated agent's own inbox. The inbox is implied by the " +
    'authenticated principal; there are no filter arguments. The payload is a body-free summary: read the ' +
    'message with the inbox or message_get tool. Messages the agent sent itself do not produce this event.',
  delivery: ['webhook'],
  inputSchema: noArgs(),
  payloadSchema: {
    type: 'object',
    properties: {
      message_id: { type: 'string', description: 'Message id; pass to message_get.' },
      seq: { type: 'number', description: 'Inbox sequence number; pass as since_seq to inbox.' },
      kind: { type: 'string', description: 'Message kind (e.g. message, task, request).' },
      request_id: { type: ['string', 'null'], description: 'Correlation id when the sender set one, else null.' },
    },
    required: ['message_id', 'seq', 'kind', 'request_id'],
    additionalProperties: false,
  },
}

const NEEDS_YOU_CREATED: EventDefinition = {
  name: 'needs_you.created',
  description:
    'A new item appeared in the needs-you (attention) queue visible to the authenticated principal. There are ' +
    'no filter arguments; visibility follows the principal\'s existing access. The payload is a body-free ' +
    'summary: read the item with the needs_you_list tool.',
  delivery: ['webhook'],
  inputSchema: noArgs(),
  payloadSchema: {
    type: 'object',
    properties: {
      item_id: { type: 'string', description: 'Needs-you item id.' },
      project_id: { type: 'string', description: 'Owning project id, when the item belongs to one.' },
      kind: { type: 'string', description: 'Item kind.' },
    },
    required: ['item_id', 'kind'],
    additionalProperties: false,
  },
}

/**
 * The v1 catalogue for a principal.
 *  - `bound`: the session is bound to an agent (auth.boundAgentId). An unbound / zero-capability
 *    directory session has no inbox and gets an EMPTY catalogue (not a filtered full one).
 *  - `canReadNeedsYou`: the principal could already call needs_you_list (its floor). The catalogue
 *    never advertises an event whose read tool the principal could not call.
 */
export function eventCatalogue(opts: { bound: boolean; canReadNeedsYou: boolean }): EventDefinition[] {
  if (!opts.bound) return []
  const out: EventDefinition[] = [structuredClone(MESSAGE_CREATED)]
  if (opts.canReadNeedsYou) out.push(structuredClone(NEEDS_YOU_CREATED))
  return out
}
