import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const dashboardSource = readFileSync(new URL('../src/dashboard/index.ts', import.meta.url), 'utf8')

describe('dashboard authenticated account shell', () => {
  it('renders the authoritative /auth/me org role before any legacy capability field', () => {
    expect(dashboardSource).toContain('if (role && (a.role || a.capability)) role.textContent = a.role || a.capability;')
  })
})
