import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const messagesPath = join(root, 'src', 'agents', 'messages.ts')
const observerPath = join(root, 'src', 'agents', 'wake-echo-observer.ts')

describe('connection echo cut scope', () => {
  it('restores the shared inbox primitive to the approved base bytes', () => {
    const digest = createHash('sha256').update(readFileSync(messagesPath)).digest('hex')
    expect(digest).toBe('2d7ccfd4c26d35bf97b4c66998666ed1b6082b8728c1d6339067d0d5a5026c48')
  })

  it('removes the native inbox observer module entirely', () => {
    expect(existsSync(observerPath)).toBe(false)
  })
})
