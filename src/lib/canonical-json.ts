function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError('canonical_json_invalid_unicode')
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError('canonical_json_invalid_unicode')
    }
  }
}

export function canonicalJson(value: unknown): string {
  const stack = new WeakSet<object>()
  const encode = (item: unknown): string => {
    if (item === null) return 'null'
    if (typeof item === 'string') {
      assertUnicodeScalarString(item)
      return JSON.stringify(item)
    }
    if (typeof item === 'boolean') return item ? 'true' : 'false'
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new TypeError('canonical_json_non_finite_number')
      return JSON.stringify(item)
    }
    if (typeof item !== 'object') throw new TypeError('canonical_json_unsupported_value')
    if (stack.has(item)) throw new TypeError('canonical_json_cycle')
    stack.add(item)
    try {
      if (Array.isArray(item)) {
        const entries: string[] = []
        for (let index = 0; index < item.length; index += 1) {
          if (!Object.hasOwn(item, index)) throw new TypeError('canonical_json_unsupported_value')
          entries.push(encode(item[index]))
        }
        return `[${entries.join(',')}]`
      }
      const prototype = Object.getPrototypeOf(item)
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError('canonical_json_unsupported_value')
      const record = item as Record<string, unknown>
      const entries = Object.keys(record).sort().map((key) => {
        assertUnicodeScalarString(key)
        return `${JSON.stringify(key)}:${encode(record[key])}`
      })
      return `{${entries.join(',')}}`
    } finally {
      stack.delete(item)
    }
  }
  return encode(value)
}
