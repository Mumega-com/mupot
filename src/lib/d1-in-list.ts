/**
 * D1 refuses a statement with more than 100 bound parameters (mupot#1676). Any
 * `IN (...)` built from a caller-sized list must be split so each statement stays
 * under that ceiling, leaving room for the statement's fixed parameters.
 */
export const D1_MAX_BOUND_PARAMETERS = 100
export const D1_IN_LIST_CHUNK_SIZE = 90

export function chunkForD1InList<T>(values: readonly T[], size = D1_IN_LIST_CHUNK_SIZE): T[][] {
  if (!Number.isInteger(size) || size < 1 || size >= D1_MAX_BOUND_PARAMETERS) {
    throw new RangeError(`chunk size must be an integer in [1, ${D1_MAX_BOUND_PARAMETERS - 1}]`)
  }
  const chunks: T[][] = []
  for (let offset = 0; offset < values.length; offset += size) {
    chunks.push(values.slice(offset, offset + size))
  }
  return chunks
}
