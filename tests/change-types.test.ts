import { describe, it, expect } from 'vitest'
import {
  isKnownChangeType,
  classifyChangeType,
  AUTO_PROPOSABLE_CHANGE_TYPES,
  FLAGGED_CHANGE_TYPES,
  HARD_REFUSED_CHANGE_TYPES,
} from '../src/departments/change-types.js'

describe('change-types', () => {
  describe('isKnownChangeType', () => {
    it('returns true for all AUTO_PROPOSABLE_CHANGE_TYPES', () => {
      for (const type of AUTO_PROPOSABLE_CHANGE_TYPES) {
        expect(isKnownChangeType(type)).toBe(true)
      }
    })

    it('returns true for all FLAGGED_CHANGE_TYPES', () => {
      for (const type of FLAGGED_CHANGE_TYPES) {
        expect(isKnownChangeType(type)).toBe(true)
      }
    })

    it('returns false for all HARD_REFUSED_CHANGE_TYPES', () => {
      for (const type of HARD_REFUSED_CHANGE_TYPES) {
        expect(isKnownChangeType(type)).toBe(false)
      }
    })

    it('returns false for unknown string types', () => {
      expect(isKnownChangeType('unknown_type')).toBe(false)
      expect(isKnownChangeType('')).toBe(false)
    })

    it('returns false for non-string types', () => {
      expect(isKnownChangeType(null)).toBe(false)
      expect(isKnownChangeType(undefined)).toBe(false)
      expect(isKnownChangeType(123)).toBe(false)
      expect(isKnownChangeType({})).toBe(false)
      expect(isKnownChangeType([])).toBe(false)
    })
  })

  describe('classifyChangeType', () => {
    it('returns "auto" for all AUTO_PROPOSABLE_CHANGE_TYPES', () => {
      for (const type of AUTO_PROPOSABLE_CHANGE_TYPES) {
        expect(classifyChangeType(type)).toBe('auto')
      }
    })

    it('returns "flagged" for all FLAGGED_CHANGE_TYPES', () => {
      for (const type of FLAGGED_CHANGE_TYPES) {
        expect(classifyChangeType(type)).toBe('flagged')
      }
    })

    it('returns "refused" for all HARD_REFUSED_CHANGE_TYPES', () => {
      for (const type of HARD_REFUSED_CHANGE_TYPES) {
        expect(classifyChangeType(type)).toBe('refused')
      }
    })

    it('returns "refused" for unknown string types', () => {
      expect(classifyChangeType('unknown_type')).toBe('refused')
      expect(classifyChangeType('')).toBe('refused')
    })

    it('returns "refused" for non-string types', () => {
      expect(classifyChangeType(null)).toBe('refused')
      expect(classifyChangeType(undefined)).toBe('refused')
      expect(classifyChangeType(123)).toBe('refused')
      expect(classifyChangeType({})).toBe('refused')
      expect(classifyChangeType([])).toBe('refused')
    })
  })
})
