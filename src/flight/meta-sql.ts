const JS_TRIM_CODEPOINTS = 'char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)'

function trimmedTextSql(value: string): string {
  return `trim(CAST(${value} AS TEXT), ${JS_TRIM_CODEPOINTS})`
}

function boundedTextSql(value: string, maxLength: number): string {
  return `length(${trimmedTextSql(value)}) > 0
    AND length(CAST(CAST(${value} AS TEXT) AS BLOB)) <= ${maxLength}`
}

function boundedFlightMetaTextSql(meta: string, path: string, maxLength: number): string {
  const value = `json_extract(${meta}, '${path}')`
  return `
    AND json_type(${meta}, '${path}') = 'text'
    AND ${boundedTextSql(value, maxLength)}`
}

function boundedFlightMetaArraySql(
  meta: string,
  path: string,
  alias: string,
  maxItems: number,
  maxLength: number,
  nonEmpty: boolean,
): string {
  return `
    AND json_type(${meta}, '${path}') = 'array'
    AND json_array_length(${meta}, '${path}') ${nonEmpty ? 'BETWEEN 1 AND' : '<='} ${maxItems}
    AND NOT EXISTS (
      SELECT 1
        FROM json_each(${meta}, '${path}') ${alias}
       WHERE ${alias}.type <> 'text'
          OR NOT (${boundedTextSql(`${alias}.value`, maxLength)})
    )`
}

export function canonicalFlightMetaSql(flightAlias: string): string {
  const safeMeta = `CASE WHEN json_valid(${flightAlias}.meta) THEN ${flightAlias}.meta ELSE '{}' END`
  const parentFlightId = `json_extract(${safeMeta}, '$.parent_flight_id')`
  return `
    AND json_valid(${flightAlias}.meta)
    AND json_type(${safeMeta}) = 'object'
    AND length(CAST(json(${safeMeta}) AS BLOB)) <= 16384
    AND NOT EXISTS (
      SELECT 1
        FROM json_each(${safeMeta}) meta_key
       WHERE meta_key.key NOT IN (
         'schema', 'goal_id', 'objective_id', 'squad_ids', 'task_ids', 'done_when',
         'artifact_refs', 'receipt_refs', 'confidentiality', 'publication_target', 'parent_flight_id'
       )
    )
    AND NOT EXISTS (
      SELECT 1
        FROM json_each(${safeMeta}) duplicate_key
       GROUP BY duplicate_key.key
      HAVING COUNT(*) > 1
    )
    AND json_extract(${safeMeta}, '$.schema') = 'mupot.flight.meta/v1'
    ${boundedFlightMetaTextSql(safeMeta, '$.goal_id', 200)}
    ${boundedFlightMetaTextSql(safeMeta, '$.objective_id', 200)}
    ${boundedFlightMetaArraySql(safeMeta, '$.squad_ids', 'squad_item', 8, 200, true)}
    ${boundedFlightMetaArraySql(safeMeta, '$.task_ids', 'task_item', 200, 200, true)}
    ${boundedFlightMetaArraySql(safeMeta, '$.done_when', 'done_item', 100, 1000, true)}
    ${boundedFlightMetaArraySql(safeMeta, '$.artifact_refs', 'artifact_item', 200, 2000, false)}
    ${boundedFlightMetaArraySql(safeMeta, '$.receipt_refs', 'receipt_item', 200, 2000, false)}
    AND json_type(${safeMeta}, '$.confidentiality') = 'text'
    AND json_extract(${safeMeta}, '$.confidentiality') IN ('private', 'internal', 'public-projection')
    AND json_type(${safeMeta}, '$.publication_target') = 'text'
    AND json_extract(${safeMeta}, '$.publication_target') IN ('none', 'inkwell-draft', 'mumega.com')
    AND json_type(${safeMeta}, '$.parent_flight_id') IN ('null', 'text')
    AND (
      json_type(${safeMeta}, '$.parent_flight_id') = 'null'
      OR (${boundedTextSql(parentFlightId, 200)})
    )`
}
