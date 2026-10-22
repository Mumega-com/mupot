// mupot — how the MAIN Worker reaches a ProjectOffice. SDK-free on purpose.
//
// The office class lives in its own Worker (workers/project-office/); the main Worker would hold a Durable
// Object binding with `script_name` pointing at it (documented, commented out, in wrangler.example.toml).
// The one production caller is office-intake.ts (GitHub webhook -> notice), behind the same flag.

import type { Notice } from './office-contract'
import {
  isProjectOfficeEnabled,
  projectOfficeName,
  type OfficeEnv,
  type NoticeResult,
  type OfficeStubResult,
  type RebuildResult,
} from './office-core'

/** The RPC surface of an office: exactly these methods, nothing inherited. */
export interface ProjectOfficeHandle {
  notice(notice: Notice): Promise<NoticeResult>
  prepare(): Promise<OfficeStubResult>
  dispatch(): Promise<OfficeStubResult>
  followUp(): Promise<OfficeStubResult>
  gate(): Promise<OfficeStubResult>
  remember(): Promise<OfficeStubResult>
  report(): Promise<OfficeStubResult>
  rebuild(): Promise<RebuildResult | Extract<OfficeStubResult, { error: 'unbound' }>>
}

/**
 * The ONE way to reach an office. Returns null unless PROJECT_OFFICE=1 and the namespace is
 * bound, so a caller that forgot to check the flag still cannot wake one.
 */
export function getProjectOffice(
  env: Pick<OfficeEnv, 'TENANT_SLUG' | 'PROJECT_OFFICE' | 'PROJECT_OFFICE_DO'>,
  projectId: string,
): ProjectOfficeHandle | null {
  const ns = env.PROJECT_OFFICE_DO
  if (!isProjectOfficeEnabled(env) || ns === undefined) return null
  const stub = ns.get(ns.idFromName(projectOfficeName(env.TENANT_SLUG, projectId)))
  // The stub's RPC type is untyped here (a generic DurableObjectNamespace); narrowing it to the office's
  // explicit surface is the contract, and the worker side is tested to expose exactly these methods.
  return stub as unknown as ProjectOfficeHandle
}
