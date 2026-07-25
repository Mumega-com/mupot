import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_DAILY_GROUNDED_QUERIES,
  validateScannerConfig,
} from './contract.mjs'

function validConfig() {
  return {
    schema: 'dme.geo-scanner-config/v1',
    project_id: 'viamar',
    google_project_id: 'mumegaproject',
    location: 'global',
    model: 'gemini-2.5-flash',
    posthog_host: 'https://us.i.posthog.com',
    daily_query_cap: 3,
    state_file: '/var/lib/mupot/geo-budget/state.json',
    mupot: {
      base_url: 'https://mupot-viamar.weathered-scene-2272.workers.dev',
      receipt_to: 'viamar-geo-receipts',
    },
    profiles: [{
      id: 'viamar',
      target_domain: 'viamar.ca',
      market: 'Canada',
      tracked_competitors: ['Example Shipping'],
      prompts: [{
        id: 'international-movers-toronto',
        text: 'Which companies are best for international household-goods moving from Toronto, Canada?',
      }],
    }],
  }
}

test('normalizes the exact project-scoped Viamar scanner contract', () => {
  assert.equal(MAX_DAILY_GROUNDED_QUERIES, 25)
  assert.deepEqual(validateScannerConfig(validConfig()), {
    schema: 'dme.geo-scanner-config/v1',
    projectId: 'viamar',
    googleProjectId: 'mumegaproject',
    location: 'global',
    model: 'gemini-2.5-flash',
    posthogHost: 'https://us.i.posthog.com',
    dailyQueryCap: 3,
    stateFile: '/var/lib/mupot/geo-budget/state.json',
    mupot: {
      baseUrl: 'https://mupot-viamar.weathered-scene-2272.workers.dev',
      receiptTo: 'viamar-geo-receipts',
    },
    profiles: [{
      id: 'viamar',
      targetDomain: 'viamar.ca',
      market: 'Canada',
      trackedCompetitors: ['Example Shipping'],
      prompts: [{
        id: 'international-movers-toronto',
        text: 'Which companies are best for international household-goods moving from Toronto, Canada?',
      }],
    }],
  })
})

test('rejects configuration that can spend beyond the compiled daily ceiling', () => {
  assert.throws(
    () => validateScannerConfig({ ...validConfig(), daily_query_cap: 26 }),
    /invalid_daily_query_cap/,
  )
  assert.doesNotThrow(
    () => validateScannerConfig({
      ...validConfig(),
      daily_query_cap: 25,
      profiles: Array.from({ length: 5 }, (_, profileIndex) => ({
        id: `profile-${profileIndex}`,
        target_domain: `profile-${profileIndex}.example`,
        market: 'Canada',
        tracked_competitors: [],
        prompts: Array.from({ length: 5 }, (_, promptIndex) => ({
          id: `prompt-${promptIndex}`,
          text: `Grounded visibility prompt ${profileIndex}-${promptIndex}`,
        })),
      })),
    }),
  )
})

test('rejects unsafe hosts, fixed-runtime drift, and unexpected project identity', () => {
  const cases = [
    { ...validConfig(), project_id: '../viamar' },
    { ...validConfig(), google_project_id: '' },
    { ...validConfig(), location: 'us-central1' },
    { ...validConfig(), model: 'gemini-flash-latest' },
    { ...validConfig(), posthog_host: 'http://us.i.posthog.com' },
    { ...validConfig(), posthog_host: 'https://user@us.i.posthog.com' },
    { ...validConfig(), posthog_host: 'https://us.i.posthog.com/capture' },
    {
      ...validConfig(),
      mupot: { ...validConfig().mupot, base_url: 'https://127.0.0.1' },
    },
  ]
  for (const value of cases) assert.throws(() => validateScannerConfig(value))
})

test('rejects duplicate prompt IDs and bounded-array/string violations', () => {
  const base = validConfig()
  const duplicatePrompts = {
    ...base,
    profiles: [{
      ...base.profiles[0],
      prompts: [base.profiles[0].prompts[0], { ...base.profiles[0].prompts[0] }],
    }],
  }
  const tooManyProfiles = {
    ...base,
    profiles: Array.from({ length: 6 }, (_, index) => ({
      ...base.profiles[0],
      id: `profile-${index}`,
    })),
  }
  const tooManyPrompts = {
    ...base,
    profiles: [{
      ...base.profiles[0],
      prompts: Array.from({ length: 6 }, (_, index) => ({
        id: `prompt-${index}`,
        text: `Prompt ${index}`,
      })),
    }],
  }
  const tooLongPrompt = {
    ...base,
    profiles: [{
      ...base.profiles[0],
      prompts: [{ id: 'long', text: 'x'.repeat(601) }],
    }],
  }
  const tooManyCompetitors = {
    ...base,
    profiles: [{
      ...base.profiles[0],
      tracked_competitors: Array.from({ length: 11 }, (_, index) => `Competitor ${index}`),
    }],
  }
  for (const value of [duplicatePrompts, tooManyProfiles, tooManyPrompts, tooLongPrompt, tooManyCompetitors]) {
    assert.throws(() => validateScannerConfig(value))
  }
})

test('rejects unknown fields instead of silently weakening the contract', () => {
  assert.throws(() => validateScannerConfig({ ...validConfig(), token: 'not-allowed' }), /invalid_config_keys/)
  assert.throws(() => validateScannerConfig({
    ...validConfig(),
    profiles: [{ ...validConfig().profiles[0], secret: 'not-allowed' }],
  }), /invalid_profile_keys/)
})
