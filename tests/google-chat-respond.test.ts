import { describe, expect, it } from 'vitest'
import { googleChatAdapter } from '../src/channels/adapters/google-chat'
import type { Env, InboundMessage } from '../src/types'

describe('googleChatAdapter.respond', () => {
  const fakeEnv = {
    GOOGLE_CHAT_VERIFY_TOKEN: 'test-verify-token',
  } as unknown as Env

  it('rejects unauthorized requests with 401 fail-closed', async () => {
    const req = new Request('https://pot.example/channels/google-chat/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer wrong-token',
      },
      body: JSON.stringify({ type: 'MESSAGE' }),
    })

    const runMock = async (_inbound: InboundMessage) => 'reply text'
    const res = await googleChatAdapter.respond!(req, fakeEnv, runMock)

    expect(res).not.toBeNull()
    expect(res?.status).toBe(401)
    const json = await res?.json()
    expect(json).toEqual({ error: 'unauthorized' })
  })

  it('returns empty 200 JSON for non-message events or ignored payloads', async () => {
    const req = new Request('https://pot.example/channels/google-chat/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-verify-token',
      },
      body: JSON.stringify({ type: 'ADDED_TO_SPACE' }),
    })

    const runMock = async (_inbound: InboundMessage) => 'reply text'
    const res = await googleChatAdapter.respond!(req, fakeEnv, runMock)

    expect(res).not.toBeNull()
    expect(res?.status).toBe(200)
    const json = await res?.json()
    expect(json).toEqual({})
  })

  it('returns synchronous { text: reply } JSON on valid message event', async () => {
    const req = new Request('https://pot.example/channels/google-chat/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-verify-token',
      },
      body: JSON.stringify({
        type: 'MESSAGE',
        space: { name: 'spaces/AAAA1234' },
        message: {
          sender: { email: 'hadi@mumega.com', type: 'HUMAN' },
          text: 'status',
          argumentText: 'status',
        },
      }),
    })

    let capturedInbound: InboundMessage | null = null
    const runMock = async (inbound: InboundMessage) => {
      capturedInbound = inbound
      return 'Fleet status: all systems normal'
    }

    const res = await googleChatAdapter.respond!(req, fakeEnv, runMock)

    expect(res).not.toBeNull()
    expect(res?.status).toBe(200)
    expect(res?.headers.get('content-type')).toBe('application/json')
    const json = await res?.json()
    expect(json).toEqual({ text: 'Fleet status: all systems normal' })

    expect(capturedInbound).not.toBeNull()
    expect(capturedInbound).toEqual({
      platform: 'google-chat',
      externalChannelId: 'spaces/AAAA1234',
      externalUserId: 'hadi@mumega.com',
      text: 'status',
    })
  })
})
