// Machine-checkable contract policy (Kasra rules):
// 1. Lifecycle fields (status/mode/phase) — membership in declared allowedValues + whoMayFlip; never single-literal equality in tests.
// 2. JSON↔TS mirrors — assert JSON === TS export; never retyped literals in tests.

export type LifecycleFieldName = 'status' | 'mode' | 'phase'

export interface LifecycleFieldDeclaration {
  field: LifecycleFieldName
  allowedValues: readonly string[]
  whoMayFlip: readonly string[]
}

export interface JsonTsMirrorDeclaration {
  jsonPath: readonly string[]
  tsExportName: string
}

export interface ContractAssertPolicySpec {
  lifecycleFields: readonly LifecycleFieldDeclaration[]
  jsonTsMirrors: readonly JsonTsMirrorDeclaration[]
}

export type PolicyFindingCode =
  | 'lifecycle_missing_allowed_values'
  | 'lifecycle_missing_who_may_flip'
  | 'lifecycle_value_not_in_allowed_set'
  | 'lifecycle_test_literal_equality'
  | 'json_ts_mirror_missing_ts_constant'
  | 'json_ts_mirror_value_mismatch'
  | 'json_ts_mirror_literal_in_test'
  // Token-presence lint only: regex over suite source. Commented-out /
  // it.skip / dead-branch text still "count". Not a behavioral enforcement.
  | 'json_ts_mirror_assertion_token_absent'

export interface PolicyFinding {
  code: PolicyFindingCode
  message: string
  jsonPath?: string
  tsExportName?: string
}

function jsonPathKey(path: readonly string[]): string {
  return path.join('.')
}

function contractAccessPath(jsonPath: readonly string[]): string {
  if (jsonPath.length === 0) {
    return 'contract'
  }
  return `contract.${jsonPath.join('.')}`
}

export function getJsonValue(
  root: Record<string, unknown>,
  path: readonly string[],
): unknown {
  let current: unknown = root
  for (const key of path) {
    if (typeof current !== 'object' || current === null) {
      return undefined
    }
    const bag = current as Record<string, unknown>
    if (!(key in bag)) {
      return undefined
    }
    current = bag[key]
  }
  return current
}

function stableEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function checkLifecycleDeclarations(
  spec: ContractAssertPolicySpec,
): PolicyFinding[] {
  const findings: PolicyFinding[] = []
  for (const row of spec.lifecycleFields) {
    if (row.allowedValues.length === 0) {
      findings.push({
        code: 'lifecycle_missing_allowed_values',
        message: `lifecycle field "${row.field}" must declare a non-empty allowedValues set`,
        jsonPath: row.field,
      })
    }
    if (row.whoMayFlip.length === 0) {
      findings.push({
        code: 'lifecycle_missing_who_may_flip',
        message: `lifecycle field "${row.field}" must declare whoMayFlip`,
        jsonPath: row.field,
      })
    }
  }
  return findings
}

export function checkLifecycleValues(
  spec: ContractAssertPolicySpec,
  contractJson: Record<string, unknown>,
): PolicyFinding[] {
  const findings: PolicyFinding[] = []
  for (const row of spec.lifecycleFields) {
    const value = contractJson[row.field]
    if (typeof value !== 'string') {
      findings.push({
        code: 'lifecycle_value_not_in_allowed_set',
        message: `lifecycle field "${row.field}" must be a string present in allowedValues`,
        jsonPath: row.field,
      })
      continue
    }
    if (!(row.allowedValues as readonly string[]).includes(value)) {
      findings.push({
        code: 'lifecycle_value_not_in_allowed_set',
        message: `lifecycle value "${value}" for "${row.field}" is not in declared allowedValues`,
        jsonPath: row.field,
      })
    }
  }
  return findings
}

export function checkJsonTsMirrors(
  spec: ContractAssertPolicySpec,
  contractJson: Record<string, unknown>,
  tsExports: Record<string, unknown>,
): PolicyFinding[] {
  const findings: PolicyFinding[] = []
  for (const mirror of spec.jsonTsMirrors) {
    const pathLabel = jsonPathKey(mirror.jsonPath)
    if (!(mirror.tsExportName in tsExports)) {
      findings.push({
        code: 'json_ts_mirror_missing_ts_constant',
        message: `mirror "${pathLabel}" requires TS export "${mirror.tsExportName}"`,
        jsonPath: pathLabel,
        tsExportName: mirror.tsExportName,
      })
      continue
    }
    const jsonValue = getJsonValue(contractJson, mirror.jsonPath)
    const tsValue = tsExports[mirror.tsExportName]
    const normalizedTs =
      Array.isArray(tsValue) && Array.isArray(jsonValue)
        ? [...tsValue]
        : tsValue
    if (!stableEqual(jsonValue, normalizedTs)) {
      findings.push({
        code: 'json_ts_mirror_value_mismatch',
        message: `mirror "${pathLabel}" JSON value does not match TS export "${mirror.tsExportName}"`,
        jsonPath: pathLabel,
        tsExportName: mirror.tsExportName,
      })
    }
  }
  return findings
}

function lifecycleLiteralEqualityPattern(field: LifecycleFieldName): RegExp {
  return new RegExp(
    String.raw`expect\s*\(\s*contract\.${field}\s*\)\s*\.(?:toBe|toEqual)\s*\(\s*['"\`]`,
    'g',
  )
}

export function checkTestSourceLifecycle(
  testSource: string,
  lifecycleFields: readonly LifecycleFieldDeclaration[],
): PolicyFinding[] {
  const findings: PolicyFinding[] = []
  for (const row of lifecycleFields) {
    const matches = testSource.match(lifecycleLiteralEqualityPattern(row.field))
    if (matches !== null && matches.length > 0) {
      findings.push({
        code: 'lifecycle_test_literal_equality',
        message: `test asserts contract.${row.field} via single-literal equality; use membership in declared allowedValues instead`,
        jsonPath: row.field,
      })
    }
  }
  return findings
}

function mirrorLiteralPattern(accessPath: string): RegExp {
  const escaped = accessPath.replace(/\./g, '\\.')
  return new RegExp(
    String.raw`expect\s*\(\s*${escaped}\s*\)\s*\.(?:toBe|toEqual)\s*\(\s*(?!\[\.\.\.)(?:['"\`]|(?:\[))`,
    'g',
  )
}

function mirrorUsesTsConstant(testSource: string, accessPath: string, tsExportName: string): boolean {
  const escapedPath = accessPath.replace(/\./g, '\\.')
  const spreadPattern = new RegExp(
    String.raw`expect\s*\(\s*${escapedPath}\s*\)\s*\.(?:toBe|toEqual)\s*\(\s*\[\.\.\.${tsExportName}\]`,
  )
  const directPattern = new RegExp(
    String.raw`expect\s*\(\s*${escapedPath}\s*\)\s*\.(?:toBe|toEqual)\s*\(\s*${tsExportName}\b`,
  )
  return spreadPattern.test(testSource) || directPattern.test(testSource)
}

export function checkTestSourceMirrors(
  testSource: string,
  mirrors: readonly JsonTsMirrorDeclaration[],
): PolicyFinding[] {
  const findings: PolicyFinding[] = []
  for (const mirror of mirrors) {
    const accessPath = contractAccessPath(mirror.jsonPath)
    const pathLabel = jsonPathKey(mirror.jsonPath)
    if (!mirrorUsesTsConstant(testSource, accessPath, mirror.tsExportName)) {
      findings.push({
        code: 'json_ts_mirror_assertion_token_absent',
        message:
          `suite source text lacks an assertion-token for ${accessPath} vs "${mirror.tsExportName}" `
          + `(spread/direct .toBe/.toEqual). This is a text-presence lint — comments and `
          + `it.skip still match; it does not prove the assertion runs.`,
        jsonPath: pathLabel,
        tsExportName: mirror.tsExportName,
      })
    }
    const literalHits = testSource.match(mirrorLiteralPattern(accessPath))
    if (literalHits !== null && literalHits.length > 0) {
      findings.push({
        code: 'json_ts_mirror_literal_in_test',
        message: `test retypes a literal for ${accessPath}; assert against "${mirror.tsExportName}" instead`,
        jsonPath: pathLabel,
        tsExportName: mirror.tsExportName,
      })
    }
  }
  return findings
}

export interface ContractAssertPolicyInput {
  spec: ContractAssertPolicySpec
  contractJson: Record<string, unknown>
  tsExports: Record<string, unknown>
  testSource: string
}

export function runContractAssertPolicy(input: ContractAssertPolicyInput): PolicyFinding[] {
  return [
    ...checkLifecycleDeclarations(input.spec),
    ...checkLifecycleValues(input.spec, input.contractJson),
    ...checkJsonTsMirrors(input.spec, input.contractJson, input.tsExports),
    ...checkTestSourceLifecycle(input.testSource, input.spec.lifecycleFields),
    ...checkTestSourceMirrors(input.testSource, input.spec.jsonTsMirrors),
  ]
}

export function policyFindingsInclude(
  findings: readonly PolicyFinding[],
  code: PolicyFindingCode,
): boolean {
  return findings.some((row) => row.code === code)
}
