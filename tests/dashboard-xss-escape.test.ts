import { describe, expect, it } from 'vitest'
import { agentTokenMintedBody, agentTokenPageBody } from '../src/dashboard/agent-token'
import { enrollMintedBody, enrollPageBody } from '../src/dashboard/enroll'
import { keysMintedBody } from '../src/dashboard/keys'
import { dashboardApp } from '../src/dashboard/index'
import type { Env } from '../src/types'

// mupot#981 — the show-once agent-token page and its sibling token surfaces must never emit
// an untrusted value as markup. Every value an admin can name (agent, slug, squad, label,
// seat) is attacker-influenced from the point of view of whoever views the page.

const HOSTILE = [
  '<script>alert(1)</script>',
  `"><img src=x onerror=alert(1)>`,
  `' autofocus onfocus='alert(1)`,
  '</code></strong><svg onload=alert(1)>',
  'javascript:alert(1)',
]

async function render(v: unknown): Promise<string> {
  return String(await v)
}

// The payload text may legitimately appear escaped; what must never appear is a live tag or
// an unescaped quote/angle bracket originating from the payload.
function assertNoLiveMarkup(out: string, payload: string): void {
  // A payload with no HTML-significant characters (a bare javascript: URL) is inert text and
  // legitimately appears verbatim; every other payload must not survive unescaped.
  if (/[<>"']/.test(payload)) expect(out).not.toContain(payload)
  expect(out).not.toMatch(/<script>alert\(1\)/i)
  expect(out).not.toMatch(/<img[^>]*onerror/i)
  expect(out).not.toMatch(/<svg[^>]*onload/i)
  expect(out).not.toMatch(/['"]\s*(autofocus\s+)?(onfocus|onmouseover)\s*=/i)
  expect(out).not.toMatch(/href\s*=\s*["']?javascript:/i)
}

describe('agent-token minted page escapes every untrusted value', () => {
  for (const payload of HOSTILE) {
    it(`escapes ${JSON.stringify(payload).slice(0, 40)}`, async () => {
      const out = await render(
        agentTokenMintedBody(payload, payload, payload, payload, payload, payload, 'https://pot.example', payload),
      )
      assertNoLiveMarkup(out, payload)
    })
  }

  it('escapes the single quote (attribute breakout character)', async () => {
    const out = await render(agentTokenMintedBody("a'b", "s'l", "q'n", 'tok', 'id', 'member', 'https://pot.example', "x'y"))
    expect(out).not.toContain("a'b")
    expect(out).not.toContain("s'l")
    expect(out).toContain('&#39;')
  })
})

describe('agent-token picker page escapes agent names, squads and the error banner', () => {
  for (const payload of HOSTILE) {
    it(`escapes ${JSON.stringify(payload).slice(0, 40)}`, async () => {
      const out = await render(
        agentTokenPageBody(
          { agents: [{ id: payload, slug: payload, name: payload, squad_id: 's', squad_name: payload }] },
          payload,
          'https://pot.example',
        ),
      )
      assertNoLiveMarkup(out, payload)
    })
  }
})

describe('sibling token surfaces share the same guarantee', () => {
  for (const payload of HOSTILE) {
    it(`enroll minted page ${JSON.stringify(payload).slice(0, 30)}`, async () => {
      const out = await render(enrollMintedBody(payload, payload, payload, payload, payload, payload, payload, payload))
      assertNoLiveMarkup(out, payload)
    })
    it(`enroll picker page ${JSON.stringify(payload).slice(0, 30)}`, async () => {
      const out = await render(
        enrollPageBody(
          {
            principal: payload,
            memberId: null,
            seat: payload,
            preselectedAgent: null,
            agents: [
              {
                id: payload, slug: payload, name: payload, squad_id: 's', squad_name: payload,
                department_id: 'd', department_name: payload, autonomy: payload, budget_cap_cents: null,
                budget_window: payload,
                liveKeys: [{ label: payload, channel: payload, created_at: payload }],
              },
            ],
          } as unknown as Parameters<typeof enrollPageBody>[0], // fixture: only the rendered fields matter
          payload,
        ),
      )
      assertNoLiveMarkup(out, payload)
    })
    it(`keys minted page ${JSON.stringify(payload).slice(0, 30)}`, async () => {
      const out = await render(keysMintedBody(payload, payload, payload, payload))
      assertNoLiveMarkup(out, payload)
    })
  }
})

describe('dashboard-wide response hardening', () => {
  it('sets a baseline Content-Security-Policy that forbids plugins, base-uri hijack and framing', async () => {
    // Unauthenticated request: the header middleware runs after the handler for ANY response.
    const res = await dashboardApp.fetch(new Request('https://pot.example/admin/agent-token'), {} as unknown as Env) // minimal env: auth gate redirects before touching bindings
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("base-uri 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })
})
