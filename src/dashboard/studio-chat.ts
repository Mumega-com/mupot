// src/dashboard/studio-chat.ts — Always-on Studio Co-Pilot (POST /api/studio/chat).
//
// Streaming SSE/text chat for the Studio canvas. Authority is resolved from the
// dashboard session (`getAuthContext` / peekSessionAuth) or a member bearer
// token. Admin/owner sessions execute with full tool-calling; everyone else
// (member, public, unauthenticated) is read-only member scope.

import type { Context } from 'hono'
import { peekSessionAuth } from '../auth'
import { isOrgAdmin, resolveCapabilities } from '../auth/capability'
import { bearerToken, resolveMemberByToken } from '../auth/member-bearer'
import { createModel } from '../model'
import { formatCachedPrompt, keepAliveCacheSession } from '../ai/cache-context'
import type { AuthContext, Env, ModelMessage } from '../types'
import {
  buildCopilotPersonaPrompt,
  copilotRecipientDef,
  normalizeCopilotRecipient,
  type CopilotRecipientId,
} from './copilot'

export const STUDIO_CHAT_ADMIN_TOOLS = [
  'squad_create',
  'cursor_dispatch',
  'task_create',
  'loop_control',
] as const

export const STUDIO_CHAT_MODELS = [
  '@cf/meta/llama-3.3-70b-instruct',
  '@cf/qwen/qwen2.5-coder-32b-instruct',
] as const

export type StudioChatRole = 'admin' | 'member'
export type StudioChatSource = 'session' | 'bearer' | 'guest'

export interface StudioChatAuthority {
  role: StudioChatRole
  tools: readonly string[]
  operator: string
  tenant: string
  guest: boolean
  source: StudioChatSource
}

export interface StudioChatTurn {
  role: 'user' | 'assistant'
  content: string
}

export type StudioChatEvent =
  | { type: 'meta'; agent: CopilotRecipientId; role: StudioChatRole; tools: readonly string[]; tenant: string; guest: boolean }
  | { type: 'token'; text: string }
  | { type: 'proposal'; action: 'launch_cloud_build' }
  | { type: 'done' }

const STUDIO_CHAT_TOOL_DEFS = [
  {
    name: 'squad_create',
    description: 'Create a squad in the current tenant.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        department_id: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'cursor_dispatch',
    description: 'Launch a Cursor Cloud agent for a negotiated Studio flight.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        repo_url: { type: 'string' },
        prompt: { type: 'string' },
      },
      required: ['name', 'repo_url', 'prompt'],
    },
  },
  {
    name: 'task_create',
    description: 'Create a task on a squad.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        squad_id: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['title'],
    },
  },
  {
    name: 'loop_control',
    description: 'Pause, kill, or budget-cap a running loop.',
    parameters: {
      type: 'object',
      properties: {
        loop_id: { type: 'string' },
        action: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['loop_id', 'action'],
    },
  },
]

const MUTATION_RE =
  /\b(squad_create|cursor_dispatch|task_create|loop_control|create (a )?squad|dispatch (a )?(flight|agent)|launch (a )?(cloud )?build|kill (the )?loop)\b/i

export function studioChatAuthorityFromAuth(
  auth: AuthContext | null | undefined,
  tenant: string,
  source: StudioChatSource = auth ? 'session' : 'guest',
): StudioChatAuthority {
  const admin = Boolean(auth) && (isOrgAdmin(auth) || auth?.role === 'admin' || auth?.role === 'owner')
  if (auth && admin) {
    return {
      role: 'admin',
      tools: STUDIO_CHAT_ADMIN_TOOLS,
      operator: auth.email || auth.userId,
      tenant: auth.tenant || tenant,
      guest: false,
      source,
    }
  }
  return {
    role: 'member',
    tools: [],
    operator: auth?.email || auth?.userId || 'guest',
    tenant: auth?.tenant || tenant,
    guest: !auth,
    source: auth ? source : 'guest',
  }
}

export async function resolveStudioChatCaller(c: Context<{ Bindings: Env; Variables: { auth?: AuthContext } }>): Promise<StudioChatAuthority> {
  const session = await peekSessionAuth(c as Context<{ Bindings: Env; Variables: { auth: AuthContext } }>)
  if (session) return studioChatAuthorityFromAuth(session, c.env.TENANT_SLUG, 'session')

  const identity = await resolveMemberByToken(c.env, bearerToken(c.req.header('authorization')))
  if (identity) {
    const capabilities = await resolveCapabilities(c.env, identity.memberId)
    const auth: AuthContext = {
      userId: identity.memberId,
      email: identity.email,
      role: 'member',
      tenant: c.env.TENANT_SLUG,
      memberId: identity.memberId,
      channel: 'workspace',
      capabilities,
      boundAgentId: identity.boundAgentId,
      tokenId: identity.tokenId,
    }
    return studioChatAuthorityFromAuth(auth, c.env.TENANT_SLUG, 'bearer')
  }

  return studioChatAuthorityFromAuth(null, c.env.TENANT_SLUG, 'guest')
}

export async function loadStudioChatContext(env: Env): Promise<{ squads: string[] }> {
  try {
    const rows = await env.DB.prepare(`SELECT name FROM squads ORDER BY name LIMIT 24`).all<{ name: string }>()
    return { squads: (rows.results ?? []).map((row) => row.name).filter(Boolean) }
  } catch {
    return { squads: [] }
  }
}

export function buildStudioChatSystemPrompt(
  authority: StudioChatAuthority,
  context: { squads: string[] },
  recipient: CopilotRecipientId | string = 'copilot',
): string {
  const persona = buildCopilotPersonaPrompt(recipient)
  const def = copilotRecipientDef(recipient)
  const squads = context.squads.length ? context.squads.join(', ') : '(none listed yet)'
  const tools = authority.role === 'admin'
    ? authority.tools.join(', ')
    : 'none — read-only queries and general assistance only'
  const scope = authority.role === 'admin'
    ? [
        'You execute with role: admin and full tool-calling capabilities.',
        `Available tools: ${tools}.`,
        'You may propose and (when the operator confirms) run squad_create, cursor_dispatch, task_create, and loop_control.',
        'When a flight / cloud build is negotiated, include the marker [[studio:launch-cloud-build]] so the Studio UI can show the Launch Cloud Build button.',
      ].join(' ')
    : [
        'You execute with role: member (read-only).',
        'You MUST refuse destructive mutations: do not run or pretend to run squad_create, cursor_dispatch, task_create, or loop_control.',
        'Help with questions, drafts, and explanations only. Point the operator at an admin if they need a mutation.',
      ].join(' ')

  return formatCachedPrompt({
    userMessage: '(see conversation turns)',
    persona: [
      persona,
      `Speaking as ${def.badge} (${def.handle} — ${def.title}).`,
      `Authority: ${authority.role}. Tools: ${tools}.`,
      scope,
      'Stay concise. Speak as a colleague who knows this pot, its squads, and the land gate (Athena + Kasra).',
    ].join('\n'),
    recipient: def.id,
    operator: `${authority.operator} (${authority.guest ? 'guest' : authority.source})`,
    operatorRole: authority.role,
    tenant: authority.tenant,
    squads: context.squads,
  }).prompt
}

export function parseStudioChatInput(body: unknown):
  | { ok: true; messages: StudioChatTurn[]; userText: string; recipient: CopilotRecipientId }
  | { ok: false; error: 'invalid_json' | 'message_required' } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'invalid_json' }
  }
  const rec = body as Record<string, unknown>
  const messages: StudioChatTurn[] = []
  const historyOrMessages = [
    ...(Array.isArray(rec.history) ? rec.history : []),
    ...(Array.isArray(rec.messages) ? rec.messages : []),
  ]
  for (const item of historyOrMessages) {
    if (!item || typeof item !== 'object') continue
    const role = (item as { role?: unknown }).role
    const content = (item as { content?: unknown }).content
    if ((role === 'user' || role === 'assistant') && typeof content === 'string' && content.trim()) {
      messages.push({ role, content: content.trim().slice(0, 8000) })
    }
  }
  const single =
    typeof rec.message === 'string' ? rec.message
    : typeof rec.prompt === 'string' ? rec.prompt
    : ''
  if (single.trim()) {
    const trimmed = single.trim().slice(0, 8000)
    if (!messages.some((turn) => turn.role === 'user' && turn.content === trimmed)) {
      messages.push({ role: 'user', content: trimmed })
    }
  }
  const lastUser = [...messages].reverse().find((turn) => turn.role === 'user')
  if (!lastUser) return { ok: false, error: 'message_required' }
  return { ok: true, messages, userText: lastUser.content, recipient: normalizeCopilotRecipient(rec.recipient) }
}

export function encodeStudioChatSse(event: StudioChatEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

export function fallbackStudioChatReply(
  authority: StudioChatAuthority,
  userText: string,
  recipient: CopilotRecipientId | string = 'copilot',
): string {
  const def = copilotRecipientDef(recipient)
  const voice =
    def.id === 'copilot'
      ? 'Mupot Co-Pilot'
      : `${def.badge} — ${def.title}`
  if (authority.role === 'member') {
    if (MUTATION_RE.test(userText)) {
      return (
        `I am ${voice}, running as member / guest (read-only). ` +
        'I cannot run squad_create, cursor_dispatch, task_create, or loop_control. ' +
        'Ask an admin to launch that work.'
      )
    }
    return (
      `${voice} — member / guest scope on tenant ${authority.tenant}. ` +
      `I am speaking as ${def.handle}. ` +
      'I can answer questions and draft prompts, but I cannot mutate the pot.'
    )
  }
  const proposal = MUTATION_RE.test(userText) ? ' [[studio:launch-cloud-build]]' : ''
  return (
    `${voice} — admin authority on tenant ${authority.tenant}. ` +
    `I am speaking as ${def.handle} (${def.title}). ` +
    `Tools available: ${authority.tools.join(', ')}. ` +
    'I can create squads, dispatch Cursor Cloud, open tasks, and govern loops.' +
    proposal
  )
}

function chunkToText(value: unknown): string {
  if (typeof value === 'string') return extractSseOrPlain(value)
  if (value instanceof Uint8Array) return extractSseOrPlain(new TextDecoder().decode(value))
  if (ArrayBuffer.isView(value)) {
    return extractSseOrPlain(new TextDecoder().decode(value as ArrayBufferView as Uint8Array))
  }
  if (value && typeof value === 'object') {
    const rec = value as { response?: unknown; text?: unknown; delta?: unknown }
    if (typeof rec.response === 'string') return rec.response
    if (typeof rec.text === 'string') return rec.text
    if (typeof rec.delta === 'string') return rec.delta
  }
  return ''
}

function extractSseOrPlain(raw: string): string {
  if (!raw.includes('data:')) return raw
  let out = ''
  for (const line of raw.split(/\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const parsed = JSON.parse(payload) as { response?: unknown; text?: unknown }
      if (typeof parsed.response === 'string') out += parsed.response
      else if (typeof parsed.text === 'string') out += parsed.text
    } catch {
      out += payload
    }
  }
  return out
}

async function* tokensFromAiResult(result: unknown): AsyncGenerator<string> {
  if (result && typeof result === 'object' && typeof (result as ReadableStream<unknown>).getReader === 'function') {
    const reader = (result as ReadableStream<unknown>).getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const text = chunkToText(value)
      if (text) yield text
    }
    return
  }
  const text = chunkToText(result)
  if (text) yield text
}

function sseStreamFromTokens(
  authority: StudioChatAuthority,
  tokens: AsyncIterable<string>,
  recipient: CopilotRecipientId = 'copilot',
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (event: StudioChatEvent) => {
        controller.enqueue(encoder.encode(encodeStudioChatSse(event)))
      }
      enqueue({
        type: 'meta',
        agent: recipient,
        role: authority.role,
        tools: authority.tools,
        tenant: authority.tenant,
        guest: authority.guest,
      })
      let sawProposal = false
      try {
        for await (const token of tokens) {
          enqueue({ type: 'token', text: token })
          if (!sawProposal && token.includes('[[studio:launch-cloud-build]]')) {
            sawProposal = true
            enqueue({ type: 'proposal', action: 'launch_cloud_build' })
          }
        }
      } finally {
        enqueue({ type: 'done' })
        controller.close()
      }
    },
  })
}

async function* fallbackTokens(text: string): AsyncGenerator<string> {
  const parts = text.match(/\S+\s*/g) ?? [text]
  for (const part of parts) yield part
}

async function runWorkersAiStream(
  env: Env,
  model: string,
  messages: ModelMessage[],
  authority: StudioChatAuthority,
): Promise<unknown> {
  const ai = env.AI
  const payload: Record<string, unknown> = {
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    stream: true,
  }
  if (authority.role === 'admin') {
    payload.tools = STUDIO_CHAT_TOOL_DEFS
  }
  return ai.run(
    model as Parameters<typeof ai.run>[0],
    payload as Parameters<typeof ai.run>[1],
  )
}

export async function streamStudioChat(
  env: Env,
  authority: StudioChatAuthority,
  turns: StudioChatTurn[],
  userText: string,
  recipient: CopilotRecipientId = 'copilot',
): Promise<ReadableStream<Uint8Array>> {
  const context = await loadStudioChatContext(env)
  keepAliveCacheSession(`studio:${recipient}:${authority.tenant}`)
  const system = buildStudioChatSystemPrompt(authority, context, recipient)
  const messages: ModelMessage[] = [
    { role: 'system', content: system },
    ...turns.map((turn) => ({ role: turn.role, content: turn.content })),
  ]

  if (env.AI) {
    for (const model of STUDIO_CHAT_MODELS) {
      try {
        const result = await runWorkersAiStream(env, model, messages, authority)
        return sseStreamFromTokens(authority, tokensFromAiResult(result), recipient)
      } catch {
        // try the next model, then the non-stream LLM fallback
      }
    }
    try {
      const text = await createModel(env).chat(messages)
      if (text.trim()) return sseStreamFromTokens(authority, fallbackTokens(text), recipient)
    } catch {
      // local fallback below
    }
  }

  return sseStreamFromTokens(
    authority,
    fallbackTokens(fallbackStudioChatReply(authority, userText, recipient)),
    recipient,
  )
}

export async function handleStudioChat(
  c: Context<{ Bindings: Env; Variables: { auth?: AuthContext } }>,
): Promise<Response> {
  const authority = await resolveStudioChatCaller(c)
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }
  const parsed = parseStudioChatInput(body)
  if (!parsed.ok) return c.json({ error: parsed.error }, 400)

  const stream = await streamStudioChat(c.env, authority, parsed.messages, parsed.userText, parsed.recipient)
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Studio-Chat-Role': authority.role,
      'X-Studio-Chat-Authority': authority.role === 'admin' ? 'admin' : 'member',
    },
  })
}
