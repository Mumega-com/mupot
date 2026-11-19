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
    // Re-pinned by #2368 (task-dispatch fence in sendAgentMessage; two-lens GREEN at 8de92f3b). Any further change to messages.ts must re-pin deliberately.
    expect(digest).toBe('5f4bb32c114d93ee1ea791aadcfd859edc3395b721133464806976d94a995bef')
  })

  it('removes the native inbox observer module entirely', () => {
    expect(existsSync(observerPath)).toBe(false)
  })
})
