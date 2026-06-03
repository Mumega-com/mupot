// mupot — model component. The connect-your-model seam (ModelPort).
//
// Sovereign-core principle: an agent never hardcodes a provider or holds a raw
// provider key. It thinks through ModelPort.chat(). The CF profile routes that
// call one of two ways:
//
//   1. AI Gateway (when AI_GATEWAY_TOKEN is set + gateway coords are configured):
//      the org's chosen `model_provider` (anthropic | openai | google) is reached
//      through the org's Cloudflare AI Gateway. The gateway *brokers the provider
//      key* (Bring-Your-Own-Keys / stored keys), so this app never sees or sends a
//      raw provider key — it only sends the gateway-authorization token
//      (`cf-aig-authorization`). The token is read from env and NEVER logged.
//
//   2. Workers AI fallback (no gateway token, or gateway coords missing): the call
//      runs against env.AI.run with a chat model. Zero extra config — a freshly
//      forked pot thinks out of the box before the wizard wires a provider.
//
// Provider/gateway selection is substrate config in `org_settings` (written by the
// onboarding wizard), never tenant business content. Identity/tenant scoping is
// not this layer's concern — the caller (AgentDO) is already tenant-verified.

import type { Env, ModelPort, ModelMessage } from '../types'

// ── settings keys (written by the onboarding wizard into org_settings) ──
const KEY_PROVIDER = 'model_provider'
const KEY_GW_ACCOUNT = 'ai_gateway_account_id'
const KEY_GW_ID = 'ai_gateway_id'
const KEY_GW_MODEL_PREFIX = 'ai_gateway_model_' // + provider → default model id override

// Providers we can route to AI Gateway. Anything else falls back to Workers AI.
type GatewayProvider = 'anthropic' | 'openai' | 'google'

function isGatewayProvider(v: string | null): v is GatewayProvider {
  return v === 'anthropic' || v === 'openai' || v === 'google'
}

// ── defaults ──
// Workers AI chat model used for the fallback path and when the agent row carries
// no usable model id. A small, always-available instruct model.
const WORKERS_AI_CHAT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
const DEFAULT_MAX_TOKENS = 1024

// Per-provider default model id when the org has not pinned one in org_settings
// and the caller did not pass opts.model. Conservative, current-generation ids.
const PROVIDER_DEFAULT_MODEL: Record<GatewayProvider, string> = {
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-4o-mini',
  google: 'gemini-2.5-flash',
}

const GATEWAY_BASE = 'https://gateway.ai.cloudflare.com/v1'

// ── org_settings reads (substrate config; small, cached per request is fine) ──
async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT value FROM org_settings WHERE key = ?1')
    .bind(key)
    .first<{ value: string }>()
  const v = row?.value?.trim()
  return v && v.length > 0 ? v : null
}

interface GatewayConfig {
  accountId: string
  gatewayId: string
  token: string // cf-aig-authorization bearer; the gateway brokers the provider key
}

// Resolve gateway coordinates. Returns null (→ Workers AI fallback) unless the
// gateway token AND both gateway coordinates are present. We never invent coords.
async function resolveGateway(env: Env): Promise<GatewayConfig | null> {
  const token = env.AI_GATEWAY_TOKEN
  if (!token || token.length === 0) return null
  const accountId = await getSetting(env, KEY_GW_ACCOUNT)
  const gatewayId = await getSetting(env, KEY_GW_ID)
  if (!accountId || !gatewayId) return null
  return { accountId, gatewayId, token }
}

// Flatten ModelMessage[] into a single system + user/assistant turn list. The
// shapes below are intentionally minimal — one chat turn list, max tokens, model.
function splitMessages(messages: ModelMessage[]): {
  system: string | null
  turns: { role: 'user' | 'assistant'; content: string }[]
} {
  let system: string | null = null
  const turns: { role: 'user' | 'assistant'; content: string }[] = []
  for (const m of messages) {
    if (m.role === 'system') {
      system = system ? `${system}\n\n${m.content}` : m.content
    } else {
      turns.push({ role: m.role, content: m.content })
    }
  }
  return { system, turns }
}

// ── per-provider gateway request shapes (minimal + typed) ──

interface ChatOpts {
  model?: string
  maxTokens?: number
}

async function gatewayModelFor(env: Env, provider: GatewayProvider, opts?: ChatOpts): Promise<string> {
  if (opts?.model && opts.model.length > 0) return opts.model
  const pinned = await getSetting(env, `${KEY_GW_MODEL_PREFIX}${provider}`)
  return pinned ?? PROVIDER_DEFAULT_MODEL[provider]
}

// Anthropic Messages API via AI Gateway. Provider key is brokered by the gateway,
// so we send ONLY cf-aig-authorization (no x-api-key).
async function callAnthropic(
  gw: GatewayConfig,
  model: string,
  messages: ModelMessage[],
  maxTokens: number,
): Promise<string> {
  const { system, turns } = splitMessages(messages)
  const body: {
    model: string
    max_tokens: number
    system?: string
    messages: { role: 'user' | 'assistant'; content: string }[]
  } = { model, max_tokens: maxTokens, messages: turns }
  if (system) body.system = system

  const res = await fetch(`${GATEWAY_BASE}/${gw.accountId}/${gw.gatewayId}/anthropic/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'cf-aig-authorization': `Bearer ${gw.token}`,
    },
    body: JSON.stringify(body),
  })
  const text = await readGatewayResponse(res, 'anthropic')
  const json = text as { content?: { type?: string; text?: string }[] }
  const out = (json.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
  return out
}

// OpenAI Chat Completions via AI Gateway.
async function callOpenAI(
  gw: GatewayConfig,
  model: string,
  messages: ModelMessage[],
  maxTokens: number,
): Promise<string> {
  const body = {
    model,
    max_tokens: maxTokens,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  }
  const res = await fetch(`${GATEWAY_BASE}/${gw.accountId}/${gw.gatewayId}/openai/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-aig-authorization': `Bearer ${gw.token}`,
    },
    body: JSON.stringify(body),
  })
  const json = (await readGatewayResponse(res, 'openai')) as {
    choices?: { message?: { content?: string } }[]
  }
  return json.choices?.[0]?.message?.content ?? ''
}

// Google Gemini (generateContent) via AI Gateway's google-ai-studio provider.
async function callGoogle(
  gw: GatewayConfig,
  model: string,
  messages: ModelMessage[],
  maxTokens: number,
): Promise<string> {
  const { system, turns } = splitMessages(messages)
  const body: {
    systemInstruction?: { parts: { text: string }[] }
    contents: { role: 'user' | 'model'; parts: { text: string }[] }[]
    generationConfig: { maxOutputTokens: number }
  } = {
    contents: turns.map((t) => ({
      role: t.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: t.content }],
    })),
    generationConfig: { maxOutputTokens: maxTokens },
  }
  if (system) body.systemInstruction = { parts: [{ text: system }] }

  const res = await fetch(
    `${GATEWAY_BASE}/${gw.accountId}/${gw.gatewayId}/google-ai-studio/v1/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-aig-authorization': `Bearer ${gw.token}`,
      },
      body: JSON.stringify(body),
    },
  )
  const json = (await readGatewayResponse(res, 'google')) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[]
  }
  const parts = json.candidates?.[0]?.content?.parts ?? []
  return parts.map((p) => p.text ?? '').join('')
}

// Shared gateway response handler. Throws a CLEAR error on non-2xx WITHOUT echoing
// any auth header — only the status and the provider/body snippet, never a token.
async function readGatewayResponse(res: Response, provider: GatewayProvider): Promise<unknown> {
  if (!res.ok) {
    let detail = ''
    try {
      detail = (await res.text()).slice(0, 300)
    } catch {
      detail = '(no body)'
    }
    throw new Error(`model: AI Gateway ${provider} request failed (${res.status}): ${detail}`)
  }
  try {
    return await res.json()
  } catch {
    throw new Error(`model: AI Gateway ${provider} returned a non-JSON body`)
  }
}

// ── Workers AI fallback ──
async function callWorkersAI(env: Env, model: string, messages: ModelMessage[]): Promise<string> {
  // env.AI.run is typed against a model union; the chat model id is a constant of
  // this module (or a caller-supplied override), so we narrow at this one boundary.
  const ai = env.AI
  const resp = (await ai.run(
    model as Parameters<typeof ai.run>[0], // module-constant or caller-supplied chat model id
    {
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    } as Parameters<typeof ai.run>[1],
  )) as { response?: string } | string
  if (typeof resp === 'string') return resp
  return resp.response ?? ''
}

// ── factory ──

/**
 * createModel(env): ModelPort — the connect-your-model seam.
 *
 * chat() routes by the org's `model_provider` setting:
 *   - provider is anthropic|openai|google AND a gateway token+coords resolve
 *     → call that provider through the org's AI Gateway (key brokered by gateway);
 *   - otherwise → Workers AI (env.AI.run) with a chat model.
 * Returns the assistant's text. Any transport/provider error throws a clear Error.
 */
export function createModel(env: Env): ModelPort {
  return {
    async chat(messages: ModelMessage[], opts?: ChatOpts): Promise<string> {
      const maxTokens = opts?.maxTokens && opts.maxTokens > 0 ? opts.maxTokens : DEFAULT_MAX_TOKENS

      const provider = await getSetting(env, KEY_PROVIDER)
      const gw = isGatewayProvider(provider) ? await resolveGateway(env) : null

      if (provider && isGatewayProvider(provider) && gw) {
        const model = await gatewayModelFor(env, provider, opts)
        switch (provider) {
          case 'anthropic':
            return callAnthropic(gw, model, messages, maxTokens)
          case 'openai':
            return callOpenAI(gw, model, messages, maxTokens)
          case 'google':
            return callGoogle(gw, model, messages, maxTokens)
        }
      }

      // Fallback: Workers AI. Use the caller's model override only if it looks like
      // a Workers AI model id (starts with '@cf/'); otherwise the module default —
      // a provider-style id (e.g. "claude-…") is meaningless to env.AI.run.
      const override = opts?.model && opts.model.startsWith('@cf/') ? opts.model : null
      return callWorkersAI(env, override ?? WORKERS_AI_CHAT_MODEL, messages)
    },
  }
}
