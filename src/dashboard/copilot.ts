// src/dashboard/copilot.ts — Mupot Co-Pilot (Deep Chat drawer + full page).
//
// Replaces a hand-rolled vanilla chat surface with the <deep-chat> web component
// (deep-chat@2.1.1, loaded from ESM — this dashboard has no frontend build step).
//
// Surfaces:
//   GET  /copilot  and  GET /chat     authenticated full-height card
//   POST /api/studio/chat             Deep Chat / {message,recipient} SSE stream
//   #mupot-copilot-drawer             440px right-hand slide-over on every shell page
//
// Auth is the dashboard session. RBAC is dynamic: isOrgAdmin → role: admin,
// otherwise role: member. The stream names that authority so the client and
// tests can see it; the model (when present) is briefed the same way.

import { html, raw } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import { formatCachedPrompt, keepAliveCacheSession } from '../ai/cache-context'
import type { AuthContext, Env, ModelMessage } from '../types'
import { isOrgAdmin } from '../auth/capability'
import { createModel } from '../model'
import { pageHeader } from './ui'

export type Html = HtmlEscapedString | Promise<HtmlEscapedString>

export const DEEP_CHAT_ESM = 'https://unpkg.com/deep-chat@2.1.1/dist/deepChat.bundle.js'
export const STUDIO_CHAT_PATH = '/api/studio/chat'

export const DEEP_CHAT_REQUEST = { url: STUDIO_CHAT_PATH, method: 'POST' } as const
export const DEEP_CHAT_CONNECT = { ...DEEP_CHAT_REQUEST, stream: true } as const
export const DEEP_CHAT_IMAGES = { files: { maxNumberOfFiles: 3 } } as const
export const DEEP_CHAT_SPEECH = { webSpeech: true } as const
export const DEEP_CHAT_STYLE = {
  borderRadius: '12px',
  border: 'none',
  width: '100%',
  height: '100%',
} as const

export type CopilotRecipientId =
  | 'copilot'
  | 'river'
  | 'loom'
  | 'kasra'
  | 'athena'
  | 'cursor-architect'
  | 'cursor-builder'

export type CopilotAuthority = 'admin' | 'member'

export interface CopilotRecipient {
  readonly id: CopilotRecipientId
  readonly handle: string
  readonly name: string
  readonly title: string
  readonly letter: string
  readonly color: string
  readonly label: string
  readonly role: string
  readonly avatarColor: string
  readonly badge: string
}

function recipient(
  id: CopilotRecipientId,
  handle: string,
  name: string,
  title: string,
  letter: string,
  color: string,
  badge: string,
  label = `${name} (${title})`,
  role = title,
): CopilotRecipient {
  return { id, handle, name, title, letter, color, label, role, avatarColor: color, badge }
}

export const COPILOT_RECIPIENTS: readonly CopilotRecipient[] = [
  recipient('copilot', '@copilot', 'Copilot', 'General Pot Assistant', 'C', '#22d3ee', '✨ Co-Pilot'),
  recipient(
    'river',
    '@river',
    'River',
    'Council Lead & Continuity',
    'R',
    '#06b6d4',
    '🌊 River',
    'River (Lead)',
    'Council Lead & Continuity',
  ),
  recipient('loom', '@loom', 'Loom', 'Sprint Coordinator', 'L', '#d4a017', '🧶 Loom'),
  recipient('kasra', '@kasra', 'Kasra', 'Server Builder & Runtime Operator', 'K', '#eab308', '🔨 Kasra'),
  recipient('athena', '@athena', 'Athena', 'Gatekeeper & Safety Reviewer', 'A', '#e879f9', '🛡️ Athena'),
  recipient('cursor-architect', '@cursor-architect', 'Cursor Architect', 'Cloud Lead Architect', 'A', '#38bdf8', '☁️ Cursor Architect'),
  recipient('cursor-builder', '@cursor-builder', 'Cursor Builder', 'Cloud Implementer', 'B', '#34d399', '🛠️ Cursor Builder'),
]

export const DEFAULT_COPILOT_RECIPIENT: CopilotRecipientId = 'copilot'
export const COPILOT_RECIPIENT_STORAGE_KEY = 'mupot-copilot-recipient'

export interface DeepChatMessage {
  role?: string
  text?: string
  files?: unknown[]
}

export interface StudioChatRequest {
  message: string
  recipient: CopilotRecipientId
  messages: DeepChatMessage[]
  fileCount: number
}

const PERSONA_PROMPTS: Record<CopilotRecipientId, string> = {
  copilot:
    'You are Mupot Co-Pilot, the primary intelligence and operator assistant within this sovereign pot. Assist operators with projects, flights, and system orchestration.',
  river:
    'You are River (@river — Council Lead & Verification Lead). You hold continuity, high-coherence steering, evidence rigor, and multi-squad direction. You guide operators and coordinate builder agents toward verified outcomes.',
  loom:
    'You are Loom (@loom — Sprint Coordinator). You hold sprint truth, sequencing, briefs, receipts, sprint awareness, and bounded delegation across all squads. You speak with council authority on the current cycle.',
  kasra:
    'You are Kasra (@kasra — Server Builder & Runtime Operator). You are the system builder and runtime operator. You maintain and operate the server infrastructure, runtimes, and deployment pipelines.',
  athena:
    'You are Athena (@athena — Gatekeeper & Safety Reviewer). You are the adversarial gatekeeper and safety reviewer. You enforce gate verification, coherence, safety reviews, and challenge unproven green lights.',
  'cursor-architect':
    'You are Cursor Architect (@cursor-architect — Cloud Lead Architect). You own architecture, system design, and repo planning for multi-repo cloud builds, system interfaces, and execution boundaries.',
  'cursor-builder':
    'You are Cursor Builder (@cursor-builder — Cloud Implementer). You execute code implementation, tests, and PR delivery through code sandboxes, test-driven implementations, and pull requests.',
}

export function getCopilotRecipient(id: CopilotRecipientId): CopilotRecipient {
  return COPILOT_RECIPIENTS.find((agent) => agent.id === id) ?? COPILOT_RECIPIENTS[0]
}

export function copilotRecipientDef(id: CopilotRecipientId | string | undefined | null): CopilotRecipient {
  return getCopilotRecipient(normalizeCopilotRecipient(id))
}

export function buildCopilotPersonaPrompt(recipient: CopilotRecipientId | string | undefined | null): string {
  const norm = normalizeCopilotRecipient(recipient)
  return PERSONA_PROMPTS[norm] || PERSONA_PROMPTS.copilot
}

export function normalizeCopilotRecipient(raw: unknown): CopilotRecipientId {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase().replace(/^@/, '').replace(/_/g, '-') : ''
  return COPILOT_RECIPIENTS.some((agent) => agent.id === value)
    ? (value as CopilotRecipientId)
    : DEFAULT_COPILOT_RECIPIENT
}

export function copilotRecipientBadge(id: CopilotRecipientId | string | undefined | null): string {
  return getCopilotRecipient(normalizeCopilotRecipient(id)).badge
}

export function copilotRoleBadge(role: string | undefined | null): string {
  return role === 'admin' || role === 'owner' ? '[ 🛡️ Admin ]' : '[ 👤 Member ]'
}

export function resolveCopilotAuthority(auth: AuthContext): CopilotAuthority {
  return isOrgAdmin(auth) ? 'admin' : 'member'
}

export function formatDeepChatSseChunk(text: string): string {
  return `data: ${JSON.stringify({ text })}\n\n`
}

export function parseStudioChatPayload(
  input: unknown,
  headerRecipient?: string | null,
): { ok: true; value: StudioChatRequest } | { ok: false; error: string } {
  if (input === null || typeof input !== 'object') {
    return { ok: false, error: 'invalid_json' }
  }
  const body = input as Record<string, unknown>
  const messages = normalizeDeepChatMessages(body.messages)
  const lastUser = [...messages].reverse().find((m) => (m.role ?? 'user') !== 'ai' && (m.role ?? 'user') !== 'assistant')
  const fromMessages = typeof lastUser?.text === 'string' ? lastUser.text : ''
  const fromStandard = typeof body.message === 'string' ? body.message : ''
  const message = (fromStandard || fromMessages).trim()
  if (!message) return { ok: false, error: 'message_required' }

  return {
    ok: true,
    value: {
      message,
      recipient: normalizeCopilotRecipient(body.recipient ?? headerRecipient),
      messages,
      fileCount: countFiles(lastUser?.files) || countFiles(body.files),
    },
  }
}

export async function readStudioChatPayload(
  req: Request,
): Promise<{ ok: true; value: StudioChatRequest } | { ok: false; status: 400; error: string }> {
  const headerRecipient = req.headers.get('X-Mupot-Recipient')
  const contentType = req.headers.get('content-type') ?? ''
  try {
    if (contentType.includes('multipart/form-data')) {
      const form = await req.formData()
      return parseFormDataChat(form, headerRecipient)
    }
    const body = await req.json()
    const parsed = parseStudioChatPayload(body, headerRecipient)
    if (!parsed.ok) return { ok: false, status: 400, error: parsed.error }
    return parsed
  } catch {
    return { ok: false, status: 400, error: 'invalid_json' }
  }
}

export function composeCopilotReply(
  auth: AuthContext,
  request: StudioChatRequest,
  modelText?: string,
): string {
  const agent = getCopilotRecipient(request.recipient)
  const authority = resolveCopilotAuthority(auth)
  const roleLine = `role: ${authority}`
  const vision =
    request.fileCount > 0
      ? ` I can see ${request.fileCount} attached image${request.fileCount === 1 ? '' : 's'}.`
      : ''
  const scoped =
    authority === 'admin'
      ? 'Admin authority is live — I can brief, draft, and name gated tools you actually hold.'
      : 'Member-tier authority is live — I can brief and draft, but admin-gated tools stay closed.'
  const generated = (modelText ?? '').trim()
  if (generated) {
    return `${agent.handle} · ${roleLine}\n\n${generated}${vision}`
  }
  return [
    `${agent.handle} · ${roleLine}`,
    '',
    `${agent.name} (${agent.title}) here.${vision}`,
    scoped,
    '',
    `You said: ${request.message}`,
  ].join('\n')
}

export function chunkCopilotReply(text: string, size = 48): string[] {
  if (!text) return ['']
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size))
  return chunks
}

export function tokenizeAssistantText(text: string): string[] {
  return text.match(/\S+\s*/g) ?? (text ? [text] : [])
}

export function fallbackCopilotReply(message: string, recipient: CopilotRecipientId | string = 'copilot'): string {
  const agent = getCopilotRecipient(normalizeCopilotRecipient(recipient))
  return `${agent.name} (${agent.title}) here. You said: ${message}`
}

export interface CopilotChatBody {
  message: string
  recipient: CopilotRecipientId
  history: Array<{ role: 'user' | 'assistant'; content: string }>
}

export function parseCopilotChatBody(
  input: unknown,
): { ok: true; value: CopilotChatBody } | { ok: false; status: 400; error: string } {
  const parsed = parseStudioChatPayload(input)
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error }
  const history = parsed.value.messages
    .filter((m) => typeof m.text === 'string' && m.text.trim())
    .map((m) => ({
      role: (m.role === 'ai' || m.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
      content: m.text as string,
    }))
  const body = input as Record<string, unknown>
  if (Array.isArray(body.history)) {
    for (const item of body.history) {
      if (!item || typeof item !== 'object') continue
      const role = (item as { role?: unknown }).role
      const content = (item as { content?: unknown }).content
      if ((role === 'user' || role === 'assistant') && typeof content === 'string' && content.trim()) {
        history.push({ role, content: content.trim() })
      }
    }
  }
  return {
    ok: true,
    value: {
      message: parsed.value.message,
      recipient: parsed.value.recipient,
      history,
    },
  }
}

export function copilotSseResponse(
  _env: Env,
  body: { message: string; recipient?: string; history?: Array<{ role: 'user' | 'assistant'; content: string }> },
  modelFn: (messages: ModelMessage[]) => Promise<string>,
  role: CopilotAuthority = 'member',
): Response {
  const recipient = normalizeCopilotRecipient(body.recipient)
  const agent = getCopilotRecipient(recipient)
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }
      enqueue({ type: 'meta', agent: recipient, role })
      const cached = formatCachedPrompt({
        userMessage: body.message,
        recipient,
        persona: PERSONA_PROMPTS[recipient],
        operatorRole: role,
      })
      const messages: ModelMessage[] = [
        { role: 'system', content: `${cached.prefix} ${agent.title}` },
        ...(body.history ?? []),
        { role: 'user', content: cached.suffix },
      ]
      let source: 'model' | 'fallback' = 'model'
      let text: string
      try {
        text = (await modelFn(messages)).trim()
        if (!text) throw new Error('empty')
      } catch {
        source = 'fallback'
        text = fallbackCopilotReply(body.message, recipient)
      }
      for (const token of tokenizeAssistantText(text)) {
        enqueue({ type: 'token', text: token })
      }
      enqueue({ type: 'done', source, done: true })
      controller.close()
    },
  })
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Mupot-Copilot-Recipient': recipient,
    },
  })
}

export async function streamStudioChat(
  env: Env,
  auth: AuthContext,
  request: StudioChatRequest,
): Promise<Response> {
  const authority = resolveCopilotAuthority(auth)
  const modelText = await maybeModelReply(env, auth, request, authority)
  const reply = composeCopilotReply(auth, request, modelText)
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      try {
        for (const chunk of chunkCopilotReply(reply)) {
          controller.enqueue(encoder.encode(formatDeepChatSseChunk(chunk)))
        }
      } finally {
        controller.close()
      }
    },
  })
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Mupot-Copilot-Role': authority,
      'X-Mupot-Copilot-Recipient': request.recipient,
    },
  })
}

export function copilotDeepChatMarkup(opts?: {
  projectId?: string
  projectRepo?: string
}): Html {
  const connect = JSON.stringify(DEEP_CHAT_CONNECT)
  const images = JSON.stringify(DEEP_CHAT_IMAGES)
  const speech = JSON.stringify(DEEP_CHAT_SPEECH)
  const styleJson = JSON.stringify(DEEP_CHAT_STYLE)
  const projectId = opts?.projectId ?? ''
  const projectRepo = opts?.projectRepo ?? ''
  return html`<deep-chat
      class="mupot-deep-chat"
      connect='${raw(connect)}'
      images='${raw(images)}'
      speechToText='${raw(speech)}'
      textToSpeech='${raw(speech)}'
      data-deep-chat-style='${raw(styleJson)}'
      data-project-id="${projectId}"
      data-project-repo="${projectRepo}"
      style="border-radius:12px;border:none;width:100%;height:100%"
    ></deep-chat>`
}

export function copilotRecipientSelectHtml(selectId: string): Html {
  const options = COPILOT_RECIPIENTS.map(
    (agent) =>
      html`<option value="${agent.id}" data-color="${agent.avatarColor}" data-letter="${agent.letter}" data-role="${agent.role}">${agent.handle} — ${agent.label}</option>`,
  )
  return html`<label class="copilot-recipient mupot-copilot-recipient" data-copilot-recipient>
    <span class="mupot-copilot-avatar" data-copilot-avatar aria-hidden="true">C</span>
    <select
      id="${selectId}"
      class="mupot-copilot-recipient-select"
      aria-label="Chat recipient"
    >${options}</select>
  </label>`
}

export function copilotDrawerHtml(): Html {
  return html`<button
      type="button"
      id="mupot-copilot-fab"
      class="mupot-copilot-fab"
      aria-controls="mupot-copilot-drawer"
      aria-expanded="false"
      title="Open Co-Pilot"
    >
      <span aria-hidden="true">✦</span>
      <span class="mupot-copilot-fab-label">Co-Pilot</span>
    </button>
    <div id="mupot-copilot-scrim" class="mupot-copilot-scrim" hidden></div>
    <aside
      id="mupot-copilot-drawer"
      class="mupot-copilot-drawer"
      hidden
      aria-hidden="true"
      aria-label="Mupot Co-Pilot"
    >
      <header class="mupot-copilot-drawer-head">
        <div>
          <p class="mupot-copilot-kicker">Mupot</p>
          <h2>Co-Pilot</h2>
          <p class="mupot-copilot-role-badge">${copilotRoleBadge('member')}</p>
        </div>
        ${copilotRecipientSelectHtml('mupot-copilot-recipient')}
        <button type="button" id="mupot-copilot-close" class="mupot-copilot-close" aria-label="Close Co-Pilot">✕</button>
      </header>
      <div class="mupot-copilot-chat-host">${copilotDeepChatMarkup()}</div>
    </aside>`
}

export function copilotPageBody(auth?: { role?: string } | null): Html {
  return html`${pageHeader({
      crumbs: 'Work / Co-Pilot',
      title: 'Co-Pilot',
      sub: 'Talk to @river, @copilot, @loom, @kasra, @athena, @cursor-architect, or @cursor-builder. Vision, voice, and streaming are live.',
    })}
    <section id="mupot-copilot-page" class="copilot-page-card ui-panel" aria-label="Co-Pilot chat">
      <div class="mupot-copilot-toolbar">
        ${copilotRecipientSelectHtml('mupot-copilot-page-recipient')}
        <span class="mupot-copilot-role-badge">${copilotRoleBadge(auth?.role)}</span>
        <p class="mupot-copilot-toolbar-hint">Drag images, paste a screenshot, or use the microphone.</p>
      </div>
      <div class="mupot-copilot-chat-host copilot-page-host">${copilotDeepChatMarkup()}</div>
    </section>`
}

export function copilotShellEmbed(): Html {
  return html`${copilotDrawerHtml()}
    <script type="module">${raw(COPILOT_BOOTSTRAP)}</script>`
}

export function copilotDrawerCss(): string {
  return COPILOT_CSS
}

function normalizeDeepChatMessages(raw: unknown): DeepChatMessage[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item) => ({
      role: typeof item.role === 'string' ? item.role : undefined,
      text: typeof item.text === 'string' ? item.text : undefined,
      files: Array.isArray(item.files) ? item.files : undefined,
    }))
}

function countFiles(files: unknown): number {
  return Array.isArray(files) ? files.length : 0
}

function parseFormDataChat(
  form: FormData,
  headerRecipient?: string | null,
): { ok: true; value: StudioChatRequest } | { ok: false; status: 400; error: string } {
  const messages: DeepChatMessage[] = []
  for (const [key, value] of form.entries()) {
    if (!/^message\d+$/i.test(key) || typeof value !== 'string') continue
    try {
      const parsed = JSON.parse(value) as unknown
      if (parsed && typeof parsed === 'object') {
        const row = parsed as Record<string, unknown>
        messages.push({
          role: typeof row.role === 'string' ? row.role : undefined,
          text: typeof row.text === 'string' ? row.text : undefined,
          files: Array.isArray(row.files) ? row.files : undefined,
        })
      }
    } catch {
      messages.push({ role: 'user', text: value })
    }
  }
  const files = form.getAll('files')
  const messageField = form.get('message')
  const assembled = {
    message: typeof messageField === 'string' ? messageField : '',
    messages,
    files,
    recipient: form.get('recipient'),
  }
  const parsed = parseStudioChatPayload(assembled, headerRecipient)
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error }
  if (files.length > 0) parsed.value.fileCount = files.length
  return parsed
}

async function maybeModelReply(
  env: Env,
  auth: AuthContext,
  request: StudioChatRequest,
  authority: CopilotAuthority,
): Promise<string | undefined> {
  const ai = (env as Env & { AI?: { run?: unknown } }).AI
  if (!ai || typeof ai.run !== 'function') return undefined
  keepAliveCacheSession(`copilot:${request.recipient}:${auth.tenant || 'pot'}`)
  const cached = formatCachedPrompt({
    userMessage: request.message,
    timestamp: new Date().toISOString(),
    recipient: request.recipient,
    persona: PERSONA_PROMPTS[request.recipient],
    operator: auth.email || auth.userId,
    operatorRole: authority,
    tenant: auth.tenant,
  })
  const turns = request.messages
    .filter((m) => typeof m.text === 'string' && m.text.trim())
    .slice(-8)
    .map((m) => ({
      role: (m.role === 'ai' || m.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
      content: m.text as string,
    }))
  const prior = turns.at(-1)?.role === 'user' ? turns.slice(0, -1) : turns
  const history: ModelMessage[] = [
    { role: 'system', content: cached.prefix },
    ...prior,
    { role: 'user', content: cached.suffix },
  ]
  try {
    const text = await createModel(env).chat(history, { maxTokens: 512 })
    return text.trim() || undefined
  } catch {
    return undefined
  }
}

const COPILOT_CSS = `
  .mupot-copilot-fab {
    position: fixed; right: 22px; bottom: 22px; z-index: 86;
    display: flex; align-items: center; gap: 8px;
    border: 0; border-radius: 999px; padding: 10px 14px 10px 12px;
    background: linear-gradient(135deg, #22d3ee, #d4a017);
    color: #041016; font: 700 13px var(--font-body, 'Hanken Grotesk', system-ui, sans-serif);
    cursor: pointer; box-shadow: 0 10px 30px rgba(4,16,22,.28);
  }
  .mupot-copilot-fab:hover { filter: brightness(1.06); }
  .mupot-copilot-fab[hidden],
  body.copilot-fullpage .mupot-copilot-fab { display: none; }
  .mupot-copilot-scrim {
    position: fixed; inset: 0; z-index: 90;
    background: rgba(10,10,12,.46); backdrop-filter: blur(4px);
  }
  .mupot-copilot-drawer {
    position: fixed; top: 0; right: 0; z-index: 91;
    width: 440px; max-width: 100vw; height: 100vh;
    display: flex; flex-direction: column;
    background: var(--surface, #fff); color: var(--text, #171b19);
    border-left: 1px solid var(--border, #e7e9e7);
    box-shadow: -18px 0 50px rgba(10,10,12,.22);
    transform: translateX(100%); transition: transform .22s cubic-bezier(.2,.8,.2,1);
  }
  .mupot-copilot-drawer.is-open { transform: translateX(0); }
  .mupot-copilot-drawer-head {
    display: grid; grid-template-columns: 1fr auto auto; gap: 10px; align-items: center;
    padding: 14px 14px 12px; border-bottom: 1px solid var(--border, #e7e9e7);
  }
  .mupot-copilot-kicker {
    margin: 0; font-family: var(--font-mono, 'JetBrains Mono', ui-monospace, monospace);
    font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: #22d3ee;
  }
  .mupot-copilot-drawer-head h2 {
    margin: 0; font-family: var(--font-display, 'Instrument Serif', Georgia, serif);
    font-weight: 400; font-size: 26px; line-height: 1.05;
  }
  .mupot-copilot-close {
    width: 34px; height: 34px; border-radius: 8px;
    border: 1px solid var(--border, #e7e9e7); background: transparent;
    color: var(--text2, #454c48); cursor: pointer; font-size: 16px;
  }
  .mupot-copilot-close:hover { background: var(--hover, #f4f6f4); }
  .mupot-copilot-recipient { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .mupot-copilot-avatar {
    width: 28px; height: 28px; border-radius: 50%; flex: none;
    display: flex; align-items: center; justify-content: center;
    font: 700 12px var(--font-body, 'Hanken Grotesk', system-ui, sans-serif);
    color: #041016; background: #22d3ee;
  }
  .mupot-copilot-recipient-select {
    max-width: 220px; border: 1px solid var(--border, #e7e9e7); border-radius: 8px;
    background: var(--bg, #f6f7f6); color: var(--text, #171b19);
    font: 600 12px var(--font-body, 'Hanken Grotesk', system-ui, sans-serif);
    padding: 6px 8px;
  }
  .mupot-copilot-chat-host { flex: 1; min-height: 0; padding: 10px; }
  .mupot-copilot-chat-host .mupot-deep-chat,
  deep-chat.mupot-deep-chat { display: block; width: 100%; height: 100%; min-height: 0; }
  .copilot-page-host deep-chat.mupot-deep-chat { min-height: 420px; }
  .copilot-page-card {
    display: flex; flex-direction: column;
    min-height: calc(100vh - 168px); padding: 0 !important;
  }
  .mupot-copilot-toolbar {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 14px 16px; border-bottom: 1px solid var(--border, #e7e9e7);
  }
  .mupot-copilot-toolbar-hint { margin: 0; color: var(--dim, #7a827d); font-size: 12px; }
  .mupot-copilot-role-badge {
    margin: 4px 0 0; font: 600 11px var(--font-mono, 'JetBrains Mono', ui-monospace, monospace);
    color: var(--text2, #454c48);
  }
  .copilot-page-host { min-height: 560px; height: calc(100vh - 260px); }
  [data-theme="dark"] .mupot-copilot-drawer {
    background: #161b22; color: #e6edf3; border-left-color: #2a3140;
  }
  [data-theme="dark"] .mupot-copilot-recipient-select,
  [data-theme="dark"] .mupot-copilot-close {
    background: #0e1116; color: #e6edf3; border-color: #2a3140;
  }
  @media (max-width: 720px) {
    .mupot-copilot-fab { right: 14px; bottom: 14px; padding: 10px 12px; }
    .mupot-copilot-fab-label { display: none; }
    .mupot-copilot-drawer { width: 100vw; }
    .mupot-copilot-drawer-head {
      grid-template-columns: 1fr auto; grid-template-areas: "title close" "persona persona";
    }
    .mupot-copilot-drawer-head > div { grid-area: title; }
    .mupot-copilot-recipient { grid-area: persona; }
    .mupot-copilot-close { grid-area: close; }
    .mupot-copilot-recipient-select { max-width: none; width: 100%; }
    .mupot-copilot-toolbar { flex-direction: column; align-items: stretch; }
    .copilot-page-host { min-height: 420px; height: calc(100vh - 220px); }
  }
`

const COPILOT_BOOTSTRAP = `
import '${DEEP_CHAT_ESM}';

const REQUEST = ${JSON.stringify(DEEP_CHAT_REQUEST)};
const IMAGES = ${JSON.stringify(DEEP_CHAT_IMAGES)};
const SPEECH = ${JSON.stringify(DEEP_CHAT_SPEECH)};
const STYLE = ${JSON.stringify(DEEP_CHAT_STYLE)};
const AGENTS = ${JSON.stringify(COPILOT_RECIPIENTS)};
const STORE_KEY = ${JSON.stringify(COPILOT_RECIPIENT_STORAGE_KEY)};
const KEEP_ALIVE_MS = 180000;

function agentById(id) {
  return AGENTS.find(function (a) { return a.id === id; }) || AGENTS[0];
}

function avatarDataUri(agent) {
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">'
    + '<circle cx="32" cy="32" r="32" fill="' + (agent.avatarColor || agent.color) + '"/>'
    + '<text x="32" y="41" text-anchor="middle" font-size="26" font-family="Hanken Grotesk,sans-serif" fill="#041016">'
    + agent.letter + '</text></svg>';
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

function themePalette() {
  var dark = document.documentElement.getAttribute('data-theme') === 'dark';
  return dark ? {
    background: '#0e1116',
    surface: '#161b22',
    raised: '#1c2230',
    text: '#e6edf3',
    muted: '#9aa7b5',
    line: '#2a3140',
    user: '#22d3ee',
    gold: '#d4a017'
  } : {
    background: '#f6f7f6',
    surface: '#ffffff',
    raised: '#f4f6f4',
    text: '#171b19',
    muted: '#7a827d',
    line: '#e7e9e7',
    user: '#0891b2',
    gold: '#96780A'
  };
}

function applyDeepChatTheme(chat, recipient) {
  var p = themePalette();
  var agent = agentById(recipient);
  chat.style.borderRadius = STYLE.borderRadius;
  chat.style.border = STYLE.border;
  chat.style.width = STYLE.width;
  chat.style.height = STYLE.height;
  chat.connect = {
    url: REQUEST.url,
    method: REQUEST.method,
    stream: true,
    headers: { 'X-Mupot-Recipient': recipient },
    additionalBodyProps: { recipient: recipient }
  };
  chat.images = IMAGES;
  chat.speechToText = SPEECH;
  chat.textToSpeech = SPEECH;
  chat.avatars = {
    ai: { src: avatarDataUri(agent), styles: { avatar: { borderRadius: '50%' } } },
    user: { src: avatarDataUri({ letter: 'Y', color: p.gold }), styles: { avatar: { borderRadius: '50%' } } }
  };
  chat.names = { ai: agent.name, user: 'You' };
  chat.introMessage = {
    text: agent.handle + ' ready. Paste a screenshot, drop up to 3 images, or click the microphone.'
  };
  chat.auxiliaryStyle = 'button { font-family: "Hanken Grotesk", system-ui, sans-serif; }';
  chat.textInput = {
    placeholder: { text: 'Message ' + agent.handle + '…' },
    styles: {
      container: {
        backgroundColor: p.raised,
        border: '1px solid ' + p.line,
        borderRadius: '12px',
        color: p.text,
        fontFamily: '"Hanken Grotesk", system-ui, sans-serif'
      }
    }
  };
  chat.messageStyles = {
    default: {
      shared: {
        bubble: {
          fontFamily: '"Hanken Grotesk", system-ui, sans-serif',
          backgroundColor: p.raised,
          color: p.text
        }
      },
      user: { bubble: { backgroundColor: p.user, color: '#041016' } },
      ai: { bubble: { backgroundColor: p.surface, color: p.text, border: '1px solid ' + p.line } }
    }
  };
}

function syncRecipient(id) {
  var agent = agentById(id);
  try { localStorage.setItem(STORE_KEY, agent.id); } catch (e) {}
  document.querySelectorAll('.mupot-copilot-recipient-select').forEach(function (sel) {
    sel.value = agent.id;
    var av = sel.parentElement && sel.parentElement.querySelector('[data-copilot-avatar]');
    if (av) {
      av.textContent = agent.letter;
      av.style.background = agent.avatarColor || agent.color;
    }
  });
  document.querySelectorAll('deep-chat.mupot-deep-chat').forEach(function (chat) {
    applyDeepChatTheme(chat, agent.id);
  });
}

function currentRecipient() {
  try {
    return agentById(localStorage.getItem(STORE_KEY) || 'copilot').id;
  } catch (e) {
    return 'copilot';
  }
}

function setDrawerOpen(open) {
  var drawer = document.getElementById('mupot-copilot-drawer');
  var scrim = document.getElementById('mupot-copilot-scrim');
  var fab = document.getElementById('mupot-copilot-fab');
  if (!drawer) return;
  drawer.hidden = false;
  drawer.classList.toggle('is-open', open);
  drawer.setAttribute('aria-hidden', open ? 'false' : 'true');
  if (!open) {
    window.setTimeout(function () { drawer.hidden = true; }, 220);
  }
  if (scrim) scrim.hidden = !open;
  if (fab) fab.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function visibleModal() {
  return document.querySelector('.modal:not([hidden])');
}

function submitPrefill(text) {
  if (!text) return;
  document.querySelectorAll('deep-chat.mupot-deep-chat').forEach(function (chat) {
    if (typeof chat.submitUserMessage === 'function') chat.submitUserMessage({ text: text });
    else chat.setAttribute('data-pending-prompt', text);
  });
}

function openCopilot(prefill) {
  setDrawerOpen(true);
  if (prefill) window.setTimeout(function () { submitPrefill(prefill); }, 40);
}

window.mupotOpenCopilot = function (prefill) {
  openCopilot(typeof prefill === 'string' ? prefill : '');
};

document.querySelectorAll('[data-copilot-open]').forEach(function (btn) {
  btn.addEventListener('click', function () {
    openCopilot(btn.getAttribute('data-copilot-prefill') || '');
  });
});

const onFullPage = location.pathname === '/copilot' || location.pathname === '/chat';
if (onFullPage) document.body.classList.add('copilot-fullpage');

document.querySelectorAll('.mupot-copilot-recipient-select').forEach(function (sel) {
  sel.addEventListener('change', function () { syncRecipient(sel.value); });
});

var fab = document.getElementById('mupot-copilot-fab');
var closeBtn = document.getElementById('mupot-copilot-close');
var scrim = document.getElementById('mupot-copilot-scrim');
if (fab) fab.addEventListener('click', function () { setDrawerOpen(true); });
if (closeBtn) closeBtn.addEventListener('click', function () { setDrawerOpen(false); });
if (scrim) scrim.addEventListener('click', function () { setDrawerOpen(false); });
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape' || visibleModal()) return;
  var drawer = document.getElementById('mupot-copilot-drawer');
  if (!drawer || !drawer.classList.contains('is-open')) return;
  setDrawerOpen(false);
});

syncRecipient(currentRecipient());
new MutationObserver(function () { syncRecipient(currentRecipient()); })
  .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

function keepAliveCache() {
  fetch('/api/studio/chat/keepalive', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Mupot-Recipient': currentRecipient() },
    body: JSON.stringify({ recipient: currentRecipient() })
  }).catch(function () {});
}
window.setInterval(keepAliveCache, KEEP_ALIVE_MS);
`

export const COPILOT_SCRIPT = COPILOT_BOOTSTRAP
