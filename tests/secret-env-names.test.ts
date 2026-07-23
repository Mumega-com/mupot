import { describe, it, expect } from 'vitest'
import { isValidBindingName, assertBindingName, RESERVED_BINDING_NAMES } from '../src/secret-env/names'

describe('secret-env binding names', () => {
  it('accepts uppercase env-style names', () => {
    expect(isValidBindingName('NOTION_API_KEY')).toBe(true)
    expect(isValidBindingName('A')).toBe(true)
  })
  it('rejects lowercase, empty, too long, and illegal chars', () => {
    expect(isValidBindingName('notion_api_key')).toBe(false)
    expect(isValidBindingName('')).toBe(false)
    expect(isValidBindingName('1ABC')).toBe(false)
    expect(isValidBindingName('A'.repeat(65))).toBe(false)
  })
  it('rejects reserved pot bindings', () => {
    expect(RESERVED_BINDING_NAMES.has('DB')).toBe(true)
    expect(RESERVED_BINDING_NAMES.has('CONNECTOR_MASTER_KEY')).toBe(true)
    expect(() => assertBindingName('DB')).toThrow(/reserved_binding_name/)
  })
})
