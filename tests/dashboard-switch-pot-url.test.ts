// tests/dashboard-switch-pot-url.test.ts — de-mumega-ify #1: the sidebar's
// "Switch pot →" link (rendered inside shell()'s switcher-menu). Hardcoded to
// mumega's own console for every forked pot before this fix — a customer's
// users would land on OUR site. env.CONSOLE_SWITCH_POT_URL overrides it;
// unset ⇒ the current mumega URL, so mumega's own deploy is byte-identical.

import { describe, it, expect } from 'vitest'
import { resolveSwitchPotUrl, DEFAULT_CONSOLE_SWITCH_POT_URL } from '../src/dashboard/index'
import type { Env } from '../src/types'

describe('resolveSwitchPotUrl', () => {
  it('defaults to the mumega console when CONSOLE_SWITCH_POT_URL is unset (byte-identical)', () => {
    expect(resolveSwitchPotUrl({} as Env)).toBe(DEFAULT_CONSOLE_SWITCH_POT_URL)
    expect(DEFAULT_CONSOLE_SWITCH_POT_URL).toBe('https://mumega.com/dashboard/pots')
  })

  it('uses the fork-provided CONSOLE_SWITCH_POT_URL when set', () => {
    const url = resolveSwitchPotUrl({ CONSOLE_SWITCH_POT_URL: 'https://console.forkedpot.example/pots' } as Env)
    expect(url).toBe('https://console.forkedpot.example/pots')
  })

  it('an empty-string override falls back to the default (never a broken href)', () => {
    expect(resolveSwitchPotUrl({ CONSOLE_SWITCH_POT_URL: '' } as Env)).toBe(DEFAULT_CONSOLE_SWITCH_POT_URL)
  })
})
