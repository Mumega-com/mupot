/**
 * D1 refuses a statement with more than 100 bound parameters (mupot#1676). Any
 * `IN (...)` built from a caller-sized list must be split so each statement stays
 * under that ceiling, leaving room for the statement's fixed parameters.
 */
export const D1_MAX_BOUND_PARAMETERS = 100
export const D1_IN_LIST_CHUNK_SIZE = 90

/**
 * Split a caller-sized list so each statement binds at most 100 parameters. `fixedParams` is the
 * number of non-list parameters the same statement binds (mupot#1774); when given without an
 * explicit `size` the chunk shrinks to fit, and an explicit `size` plus `fixedParams` over 100 throws.
 */
export function chunkForD1InList<T>(
  values: readonly T[],
  size?: number,
  fixedParams = 0,
): T[][] {
  if (!Number.isInteger(fixedParams) || fixedParams < 0) {
    throw new RangeError('fixedParams must be a non-negative integer')
  }
  const effective = size ?? Math.min(D1_IN_LIST_CHUNK_SIZE, D1_MAX_BOUND_PARAMETERS - fixedParams)
  if (!Number.isInteger(effective) || effective < 1 || effective >= D1_MAX_BOUND_PARAMETERS || effective + fixedParams > D1_MAX_BOUND_PARAMETERS) {
    throw new RangeError(`chunk size plus fixed params must be an integer chunk of at least 1 and at most ${D1_MAX_BOUND_PARAMETERS} binds`)
  }
  size = effective
  const chunks: T[][] = []
  for (let offset = 0; offset < values.length; offset += size) {
    chunks.push(values.slice(offset, offset + size))
  }
  return chunks
}
