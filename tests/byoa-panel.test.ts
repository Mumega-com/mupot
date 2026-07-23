import { describe, it, expect } from 'vitest'
import { byoaBody } from '../src/dashboard/byoa'
import type { Env } from '../src/types'

async function render(p: ReturnType<typeof byoaBody>): Promise<string> {
  return String(await p)
}

describe('byoaBody', () => {
  it('shows Open WebUI proxy URL and ceremony', async () => {
    const out = await render(
      byoaBody({} as Env, {
        canAdmin: true,
        potOrigin: 'https://mupot.example.com',
        flash: null,
        error: null,
        binding: null,
      }),
    )
    expect(out).toContain('/api/member-hermes/v1')
    expect(out).toContain('seat_member_on_squad')
    expect(out).toContain('/agents/byoa/attach')
  })

  it('hides attach form for non-admin', async () => {
    const out = await render(
      byoaBody({} as Env, {
        canAdmin: false,
        potOrigin: 'https://mupot.example.com',
        flash: null,
        error: null,
        binding: { member_id: 'm1', agent_id: 'a1' },
      }),
    )
    expect(out).toContain('Admin required')
    expect(out).not.toContain('/agents/byoa/attach')
    expect(out).toContain('a1')
  })
})
