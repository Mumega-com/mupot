import { describe, expect, it } from 'vitest'
import { parseFlightMetaV1 } from '../src/flight/meta'

function validMeta(): Record<string, unknown> {
  return {
    schema: 'mupot.flight.meta/v1',
    goal_id: 'goal',
    objective_id: 'objective',
    squad_ids: ['squad'],
    task_ids: ['task'],
    done_when: ['done'],
    artifact_refs: [],
    receipt_refs: [],
    confidentiality: 'internal',
    publication_target: 'none',
    parent_flight_id: null,
  }
}

describe('parseFlightMetaV1', () => {
  it('applies field limits in UTF-8 bytes', () => {
    const persianCharacter = '\u06a9'
    expect(parseFlightMetaV1({ ...validMeta(), goal_id: persianCharacter.repeat(100) })).not.toBeNull()
    expect(parseFlightMetaV1({ ...validMeta(), goal_id: persianCharacter.repeat(101) })).toBeNull()
  })

  it('applies the canonical envelope limit in UTF-8 bytes', () => {
    const persianCharacter = '\u06a9'
    expect(parseFlightMetaV1({
      ...validMeta(),
      artifact_refs: Array.from({ length: 9 }, () => persianCharacter.repeat(1000)),
    })).toBeNull()
  })
})
