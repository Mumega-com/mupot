// getProjectOffice (src/projects/office-handle.ts): the ONE way the main Worker reaches an office. SDK-free.

import { describe, expect, it, vi } from 'vitest'
import { getProjectOffice } from '../src/projects/office-handle'

function namespace() {
  const stub = { tag: 'stub' }
  const idFromName = vi.fn((name: string) => ({ name }))
  const get = vi.fn(() => stub)
  return { ns: { idFromName, get } as unknown as DurableObjectNamespace, idFromName, get, stub }
}

describe('getProjectOffice', () => {
  it('returns null with the flag off, and never touches the namespace', () => {
    const { ns, idFromName, get } = namespace()
    for (const flag of [undefined, '0', 'true', '', ' 1']) {
      expect(getProjectOffice({ TENANT_SLUG: 'pot-a', PROJECT_OFFICE: flag, PROJECT_OFFICE_DO: ns }, 'p1'), String(flag)).toBeNull()
    }
    expect(idFromName).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
  })

  it('returns null with the flag on but no binding', () => {
    expect(getProjectOffice({ TENANT_SLUG: 'pot-a', PROJECT_OFFICE: '1', PROJECT_OFFICE_DO: undefined }, 'p1')).toBeNull()
  })

  it('with flag and binding, addresses the office by <tenant>:<project>', () => {
    const { ns, idFromName, get, stub } = namespace()
    expect(getProjectOffice({ TENANT_SLUG: 'pot-a', PROJECT_OFFICE: '1', PROJECT_OFFICE_DO: ns }, 'p1')).toBe(stub)
    expect(idFromName).toHaveBeenCalledWith('pot-a:p1')
    expect(get).toHaveBeenCalledTimes(1)
  })
})
