// mupot — board provider registry. Importing this module loads every provider, and each registers itself
// (registry-core.ts). To add a provider (Jira, Asana, ...): write src/projects/providers/<name>.ts that calls
// registerBoardProvider(), and add its import line below. Nothing else changes: no switch, no union, no caller.
import './github'
import './linear'
import './notion'

export {
  getTaskBoardPort,
  isProjectBoardProvider,
  listBoardProviders,
  registerBoardProvider,
} from './registry-core'
