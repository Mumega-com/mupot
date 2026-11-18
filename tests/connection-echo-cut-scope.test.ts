import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const messagesPath = join(root, 'src', 'agents', 'messages.ts')
const observerPath = join(root, 'src', 'agents', 'wake-echo-observer.ts')

describe('connection echo cut scope', () => {
  it('keeps shared inbox reads and writes independent of echo proof', () => {
    // The cut's whole-file checksum belongs to the historical receipt. Later inbox
    // changes should retain the boundary, without putting echo state or its retired
    // observer back into the shared messaging primitive.
    const source = readFileSync(messagesPath, 'utf8')
    expect(source).not.toMatch(/wake-echo-observer|connection-echo|connection_echo_(?:challenges|receipts|status)/)
  })

  it('removes the native inbox observer module entirely', () => {
    expect(existsSync(observerPath)).toBe(false)
  })
})
