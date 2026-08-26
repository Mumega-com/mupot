// tests/visual-ui-polish.test.ts — stacking, Escape, and Co-Pilot chrome pins.
//
// These assert the visual-QA polish that the 2026-08-26 production audit landed:
// modal above the Co-Pilot FAB, drawer Escape that yields to an open modal,
// and the Ask Co-Pilot / window.mupotOpenCopilot wiring.

import { describe, expect, it } from 'vitest'
import { html } from 'hono/html'
import type { Env } from '../src/types'
import { parseAthenaGateChecks } from '../src/dashboard/verifications'

const { shell } = await import('../src/dashboard')
const { copilotDrawerCss, copilotShellEmbed } = await import('../src/dashboard/copilot')
const { SANDBOX_MOBILE_MAX_WIDTH, SANDBOX_TABLET_MAX_WIDTH } = await import('../src/platform/routes')

describe('visual polish — overlay stacking', () => {
  it('raises dialogs above the floating Co-Pilot FAB and drawer', async () => {
    const markup = String(await shell({ BRAND: 'Mupot', TENANT_SLUG: 'pot-a' } as Env, 'Projects', html`<p>hi</p>`))
    expect(markup).toContain('.modal {')
    expect(markup).toContain('z-index: 110')
    expect(markup).toContain('max-height: calc(100vh - 40px)')
    expect(markup).toContain('id="mupot-copilot-fab"')
    expect(markup).toContain('z-index: 86')
    expect(markup).toContain('z-index: 91')
  })
})

describe('visual polish — Co-Pilot chrome', () => {
  it('wires Ask Co-Pilot openers and only Escapes an open drawer', async () => {
    const embed = String(await copilotShellEmbed())
    expect(embed).toContain('window.mupotOpenCopilot')
    expect(embed).toContain('[data-copilot-open]')
    expect(embed).toContain("querySelector('.modal:not([hidden])')")
    expect(embed).toContain("classList.contains('is-open')")
  })

  it('stacks the drawer header and hides the FAB label on a 375px phone', () => {
    const css = copilotDrawerCss()
    expect(css).toContain('@media (max-width: 720px)')
    expect(css).toContain('.mupot-copilot-fab-label { display: none; }')
    expect(css).toContain('.mupot-copilot-drawer { width: 100vw; }')
    expect(css).toContain('min-height: 0')
  })
})

describe('visual polish — sandbox viewport contract', () => {
  it('pins tablet 768px and mobile 375px in rem', () => {
    expect(SANDBOX_TABLET_MAX_WIDTH).toBe('48rem')
    expect(SANDBOX_MOBILE_MAX_WIDTH).toBe('23.4375rem')
  })

  it('uses the Deep Chat 2.x connect object instead of deprecated request/stream attrs', async () => {
    const { copilotDeepChatMarkup, DEEP_CHAT_CONNECT } = await import('../src/dashboard/copilot')
    const markup = String(await copilotDeepChatMarkup())
    expect(DEEP_CHAT_CONNECT.stream).toBe(true)
    expect(markup).toContain("connect='")
    expect(markup).not.toContain('request=')
    expect(markup).not.toContain('stream="true"')
  })
})

describe('visual polish — Athena check badges', () => {
  it('parses receipt checks and ignores garbage JSON', () => {
    expect(parseAthenaGateChecks('not-json')).toEqual([])
    expect(
      parseAthenaGateChecks(
        JSON.stringify([
          { id: 'no_hardcoded_secrets', name: 'No hardcoded secrets', passed: true },
          { id: 'rbac_compliance', passed: false },
        ]),
      ),
    ).toEqual([
      { name: 'No hardcoded secrets', passed: true },
      { name: 'rbac_compliance', passed: false },
    ])
  })
})
