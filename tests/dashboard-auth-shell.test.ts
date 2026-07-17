import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const dashboardSource = readFileSync(new URL('../src/dashboard/index.ts', import.meta.url), 'utf8')

describe('dashboard authenticated account shell', () => {
  it('renders the authoritative /auth/me org role before any legacy capability field', () => {
    expect(dashboardSource).toContain('if (role && (a.role || a.capability)) role.textContent = a.role || a.capability;')
  })

  it('emphasizes Home, Projects, Work, and Approvals in that order', () => {
    const home = dashboardSource.indexOf('<span class="nav-label">Home</span>')
    const projects = dashboardSource.indexOf('<span class="nav-label">Projects</span>')
    const work = dashboardSource.indexOf('<span class="nav-label">Work</span>')
    const approvals = dashboardSource.indexOf('<span class="nav-label">Approvals</span>')

    expect(home).toBeGreaterThan(-1)
    expect(projects).toBeGreaterThan(home)
    expect(work).toBeGreaterThan(projects)
    expect(approvals).toBeGreaterThan(work)
  })

  it('retains every existing sidebar destination after adding Projects', () => {
    const navStart = dashboardSource.indexOf('<nav class="nav-scroll"')
    const navEnd = dashboardSource.indexOf('</nav>', navStart)
    const sidebarNav = dashboardSource.slice(navStart, navEnd)

    expect(navStart).toBeGreaterThan(-1)
    expect(navEnd).toBeGreaterThan(navStart)
    for (const href of [
      '/admin/divisions', '/agents', '/send', '/flights', '/verifications', '/fleet', '/radar', '/ops',
      '/addons', '/coordination', '/economy', '/economy/wallet', '/economy/marketplace', '/economy/billing',
      '/members', '/admin/members', '/audit', '/deployment', '/admin/github', '/admin/keys',
    ]) {
      expect(sidebarNav).toContain(`href="${href}"`)
    }
  })
})
