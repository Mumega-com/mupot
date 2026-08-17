import { describe, it, expect } from 'vitest'
import {
  classifyChangeType,
  isKnownChangeType,
  AUTO_PROPOSABLE_CHANGE_TYPES,
  FLAGGED_CHANGE_TYPES,
  HARD_REFUSED_CHANGE_TYPES,
  CroChangeType,
} from '../../src/departments/change-types'

describe('change-types', () => {
  describe('classifyChangeType', () => {
    it('classifies auto-proposable types as auto', () => {
      for (const type of AUTO_PROPOSABLE_CHANGE_TYPES) {
        expect(classifyChangeType(type)).toBe('auto')
      }
    })

    it('classifies flagged types as flagged', () => {
      for (const type of FLAGGED_CHANGE_TYPES) {
        expect(classifyChangeType(type)).toBe('flagged')
      }
    })

    it('classifies hard-refused types as refused', () => {
      for (const type of HARD_REFUSED_CHANGE_TYPES) {
        expect(classifyChangeType(type)).toBe('refused')
      }
    })

    it('classifies unknown string types as refused', () => {
      expect(classifyChangeType('unknown_type')).toBe('refused')
      expect(classifyChangeType('')).toBe('refused')
      expect(classifyChangeType('auto')).toBe('refused') // Valid output of classification, but not a change type
    })

    it('classifies non-string inputs as refused', () => {
      expect(classifyChangeType(null)).toBe('refused')
      expect(classifyChangeType(undefined)).toBe('refused')
      expect(classifyChangeType(123)).toBe('refused')
      expect(classifyChangeType({})).toBe('refused')
      expect(classifyChangeType([])).toBe('refused')
      expect(classifyChangeType(true)).toBe('refused')
    })
  })

  describe('isKnownChangeType', () => {
    it('returns true for known auto-proposable types', () => {
      for (const type of AUTO_PROPOSABLE_CHANGE_TYPES) {
        expect(isKnownChangeType(type)).toBe(true)
      }
    })

    it('returns true for known flagged types', () => {
      for (const type of FLAGGED_CHANGE_TYPES) {
        expect(isKnownChangeType(type)).toBe(true)
      }
    })

    it('returns false for hard-refused types', () => {
      for (const type of HARD_REFUSED_CHANGE_TYPES) {
        expect(isKnownChangeType(type)).toBe(false)
      }
    })

    it('returns false for unknown string types', () => {
      expect(isKnownChangeType('unknown_type')).toBe(false)
      expect(isKnownChangeType('')).toBe(false)
    })

    it('returns false for non-string inputs', () => {
      expect(isKnownChangeType(null)).toBe(false)
      expect(isKnownChangeType(undefined)).toBe(false)
      expect(isKnownChangeType(123)).toBe(false)
      expect(isKnownChangeType({})).toBe(false)
      expect(isKnownChangeType([])).toBe(false)
    })
  })
})
