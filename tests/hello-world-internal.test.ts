import { describe, expect, it } from 'vitest'
import { generateHelloWorld } from '../src/hello-world-internal'

describe('Hello World Internal Module Suite', () => {
  it('a) returns valid HelloResponse on default input', () => {
    const res = generateHelloWorld()
    expect(res.ok).toBe(true)
    expect(res.message).toContain('Hello, World!')
    expect(res.timestamp).toBeDefined()
  })

  it('b) returns customized greeting on named input', () => {
    const res = generateHelloWorld('Hadi')
    expect(res.ok).toBe(true)
    expect(res.message).toContain('Hello, Hadi!')
  })

  it('c) throws fail-closed error on empty name input', () => {
    expect(() => generateHelloWorld('')).toThrow('Name parameter must be non-empty')
  })
})
