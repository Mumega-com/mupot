import { describe, expect, it } from 'vitest'
import { githubStatusBody } from '../src/integrations/github-dashboard'

describe('githubStatusBody', () => {
  it('renders browser-session controls for project intake and task PR execution', () => {
    const body = String(githubStatusBody({
      tier: 'free',
      enterpriseEnabled: false,
      connected: true,
      installationId: '123',
      features: [],
    }))

    expect(body).toContain('/admin/github/import-project')
    expect(body).toContain('Import assigned items')
    expect(body).toContain('/admin/github/execute-task')
    expect(body).toContain('Create task pull request')
  })
})
