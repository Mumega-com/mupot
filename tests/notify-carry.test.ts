// Notify kernel carry table: pure tests, plus the agreement proof with the approval bot's allow list.
import { describe, expect, it } from 'vitest'
import {
  ALL_CHANNELS, PLAIN_BUTTON_CHANNELS, REVERSIBLE_ACTIONS, carryChannels, classifyAction, classifyActions,
  type Severity,
} from '../src/notify/carry'
import { APPROVAL_BOT_ACTIONS, botMayCarry } from '../src/approval-bot/policy'
import { ALL_ELEVATION_ACTION_KEYS } from '../src/auth/elevation-actions'

const SEVERITIES: Severity[] = ['info', 'attention', 'decision', 'critical']

describe('carry table', () => {
  it('info and attention go to telegram_dm and dashboard', () => {
    expect(carryChannels({ severity: 'info' })).toEqual(['telegram_dm', 'dashboard'])
    expect(carryChannels({ severity: 'attention' })).toEqual(['telegram_dm', 'dashboard'])
  })

  it('a reversible decision goes to the approval bot, mini app and dashboard', () => {
    expect(carryChannels({ severity: 'decision', action_class: 'reversible' })).toEqual(['approval_bot', 'miniapp', 'dashboard'])
  })

  it('a high-risk decision is mini app / passkey link only', () => {
    expect(carryChannels({ severity: 'decision', action_class: 'high_risk' })).toEqual(['miniapp', 'passkey_link'])
  })

  it('critical reaches every channel for a reversible class', () => {
    expect([...carryChannels({ severity: 'critical', action_class: 'reversible' })].sort()).toEqual([...ALL_CHANNELS].sort())
  })

  it('GUARD: high-risk (or undeclared) never maps to a plain-button channel at any severity', () => {
    for (const severity of SEVERITIES) {
      if (severity === 'info' || severity === 'attention') continue // no action involved
      for (const action_class of ['high_risk' as const, undefined]) {
        const channels = carryChannels({ severity, action_class })
        for (const c of channels) expect(PLAIN_BUTTON_CHANNELS.has(c), `${severity}/${String(action_class)}/${c}`).toBe(false)
      }
    }
  })
})

describe('carry table agrees with the approval bot policy', () => {
  it('REVERSIBLE_ACTIONS equals APPROVAL_BOT_ACTIONS (both directions)', () => {
    expect([...REVERSIBLE_ACTIONS].sort()).toEqual([...APPROVAL_BOT_ACTIONS].sort())
  })

  it('for every known elevation action: the carry table offers the approval bot iff policy.ts lists it', () => {
    for (const key of ALL_ELEVATION_ACTION_KEYS) {
      const viaCarry = carryChannels({ severity: 'decision', action_class: classifyAction(key) }).includes('approval_bot')
      expect(viaCarry, key).toBe(APPROVAL_BOT_ACTIONS.includes(key))
      const asReq = { requested_actions_json: JSON.stringify([key]) }
      expect(classifyActions([key]) === 'reversible', key).toBe(botMayCarry(asReq))
    }
  })

  it('an unknown action key is high-risk, and a mixed request is high-risk', () => {
    expect(classifyAction('action:not_a_real_action')).toBe('high_risk')
    expect(classifyActions([APPROVAL_BOT_ACTIONS[0], 'action:mint_token'])).toBe('high_risk')
    expect(classifyActions([])).toBe('high_risk')
  })
})
