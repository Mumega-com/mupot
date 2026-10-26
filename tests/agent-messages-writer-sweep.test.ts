// Every agent_messages INSERT in src/ must be the sendAgentMessage landed-row path,
// which emits message.created. A new insert that skips that emit would also skip the
// signed doorbell (it rides the message.created consumer). The one historical exception
// is sosBusSend: an audit row that states it does not deliver and must not start.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (full.endsWith('.ts') && !full.endsWith('schema-chain.generated.ts')) out.push(full)
  }
  return out
}

describe('agent_messages insert sites emit message.created', () => {
  it('fails when an insert bypasses sendAgentMessage', () => {
    const root = join(__dirname, '..', 'src')
    const hits: string[] = []
    for (const file of walk(root)) {
      const text = readFileSync(file, 'utf8')
      if (/INSERT\s+INTO\s+agent_messages\b/i.test(text)) {
        hits.push(file.slice(root.length + 1).replaceAll('\\', '/'))
      }
    }
    expect(hits.sort()).toEqual(['agents/messages.ts', 'channels/index.ts'])

    const messages = readFileSync(join(root, 'agents/messages.ts'), 'utf8')
    const sendStart = messages.indexOf('export async function sendAgentMessage')
    expect(sendStart).toBeGreaterThan(-1)
    const sendNext = messages.indexOf('\nexport async function', sendStart + 10)
    const sendBody = messages.slice(sendStart, sendNext === -1 ? undefined : sendNext)
    expect(sendBody.match(/INSERT INTO agent_messages/g)).toHaveLength(2)
    expect(sendBody).toContain("type: 'message.created'")
    expect(messages.match(/INSERT INTO agent_messages/g)).toHaveLength(2)

    const channels = readFileSync(join(root, 'channels/index.ts'), 'utf8')
    const sosStart = channels.indexOf('async function sosBusSend')
    const sosEnd = channels.indexOf('// ── postAgentActivity', sosStart)
    const sosBody = channels.slice(sosStart, sosEnd)
    expect(sosBody).toMatch(/INSERT INTO agent_messages/)
    expect(sosBody).not.toContain('message.created')
    expect(sosBody).not.toContain('scheduleWebhookDoorbell')
    expect(channels.match(/INSERT INTO agent_messages/g)).toHaveLength(1)
  })
})
