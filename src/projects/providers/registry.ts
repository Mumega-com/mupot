import type { Env } from '../../types'
import { createGitHubProjectsBoardPort } from './github'
import { createLinearBoardPort } from './linear'
import { createNotionBoardPort } from './notion'
import type { ProjectBoardProvider, TaskBoardPort } from './port'

export function getTaskBoardPort(env: Env, provider: ProjectBoardProvider): TaskBoardPort {
  switch (provider) {
    case 'github_projects':
      return createGitHubProjectsBoardPort(env)
    case 'linear':
      return createLinearBoardPort(env)
    case 'notion':
      return createNotionBoardPort(env)
    default: {
      const _exhaustive: never = provider
      throw new Error(`unknown project board provider: ${String(_exhaustive)}`)
    }
  }
}
