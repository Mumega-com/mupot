import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const contract = JSON.parse(
  readFileSync(new URL('../docs/runtime-adapter-v1.json', import.meta.url), 'utf8'),
) as {
  id: string
  status: string
  signedAttachDomain: string
  signedDetachDomain: string
  signedInboxDomain: string
  attach: {
    signed: { path: string; required: string[]; lifecycles: string[]; errors: Record<string, string> }
    bearer: { path: string; downgradePolicy: string }
    detach: { path: string; signed: { path: string; required: string[]; domain: string } }
  }
  control: {
    version: string
    api: { path: string; required: string[] }
    consumer: { read: string; nonceLedger: string; consumePolicy: string }
    verbs: Record<string, string>
    signedBytes: string[]
  }
  presence: {
    mcpTools: string[]
    http: string
    identitySource: string
    bodyFieldsDescriptiveOnly: string[]
    debounce: string
  }
  messaging: {
    mcpTools: string[]
    http: { signedRead: { path: string; required: string[]; domain: string } }
    hostHandler: { file: string; handoff: string; commandInput: string; failure: string }
    kinds: string[]
    idempotency: { scope: string[]; identicalRetry: string; differentContent: string }
    readSemantics: { default: string; peek: string }
    broadcast: {
      defaultSquad: string
      authorization: string
      recipients: string
      includeSelf: string
      idempotency: string
    }
  }
  memory: {
    privateMcpTools: string[]
    squadMcpTools: string[]
    privateScope: string
    squadScope: string
    squadAuthorization: { write: string; read: string }
    defaultSquad: string
    vectorFilter: string[]
  }
  peerDiscovery: {
    mcpTools: string[]
    defaultSquad: string
    authorization: string
    scope: string
    presence: string
  }
  tasks: {
    mcpTools: string[]
    defaultSquad: string
    authorization: string
    statuses: string[]
    createStatuses: string[]
    patchStatuses: string[]
    verdictStatuses: string[]
    doneWhenRequired: boolean
    transitions: Record<string, string[]>
  }
  hermes: {
    webhook: { path: string; secretHeader: string }
    lifecycleName: string
    lifecycle: string[]
    taskDoneWhen: string
  }
  conformance: {
    localHarness: {
      script: string
      npmScript: string
      config: string
      seed: string
      covers: string[]
    }
    planned: string[]
  }
}

describe('runtime-adapter/v1 contract artifact', () => {
  it('documents the signed attach proof used by fleet attach', () => {
    expect(contract.id).toBe('runtime-adapter/v1')
    expect(contract.status).toBe('documented')
    expect(contract.signedAttachDomain).toBe('fleet-attach:v1')
    expect(contract.signedDetachDomain).toBe('fleet-detach:v1')
    expect(contract.signedInboxDomain).toBe('agent-inbox:v1')
    expect(contract.attach.signed.path).toBe('/api/fleet/attach-signed')
    expect(contract.attach.signed.required).toEqual([
      'agent_id',
      'type',
      'runtime',
      'lifecycle',
      'ts',
      'nonce',
      'sig',
    ])
    expect(contract.attach.signed.lifecycles).toEqual(['on_demand', 'always_on'])
    expect(contract.attach.signed.errors).toMatchObject({
      '401': 'unauthorized',
      '409': 'replay',
    })
  })

  it('captures bearer attach, detach, and inbox idempotency semantics', () => {
    expect(contract.attach.bearer.path).toBe('/api/fleet/attach')
    expect(contract.attach.bearer.downgradePolicy).toContain('refuse-bearer-attach')
    expect(contract.attach.detach.path).toBe('/api/fleet/detach')
    expect(contract.attach.detach.signed).toMatchObject({
      path: '/api/fleet/detach-signed',
      domain: 'fleet-detach:v1',
    })
    expect(contract.attach.detach.signed.required).toEqual(['agent_id', 'ts', 'nonce', 'sig'])
    expect(contract.messaging.mcpTools).toEqual(['send', 'inbox', 'broadcast'])
    expect(contract.messaging.http.signedRead).toMatchObject({
      path: '/api/inbox/signed',
      domain: 'agent-inbox:v1',
    })
    expect(contract.messaging.http.signedRead.required).toEqual(['agent_id', 'peek', 'limit', 'ts', 'nonce', 'sig'])
    expect(contract.messaging.kinds).toEqual(['message', 'request', 'ack'])
    expect(contract.messaging.idempotency.scope).toEqual(['tenant', 'from_agent', 'request_id'])
    expect(contract.messaging.idempotency.identicalRetry).toBe('duplicate:true')
    expect(contract.messaging.idempotency.differentContent).toBe('request_id_conflict')
    expect(contract.messaging.readSemantics).toEqual({ default: 'consume', peek: 'non-consuming' })
    expect(contract.messaging.broadcast).toMatchObject({
      authorization: 'member-on-target-squad',
      recipients: 'active-agents-in-target-squad-excluding-self-by-default',
      includeSelf: 'include_self-true',
      idempotency: 'caller-request_id-derived-per-recipient',
    })
    expect(contract.messaging.broadcast.defaultSquad).toContain('auth.boundAgentId')
    expect(contract.messaging.hostHandler).toMatchObject({
      file: 'fleet-runtime/inbox-handler.mjs',
      handoff: 'write-0600-spool-before-exit-0',
    })
    expect(contract.messaging.hostHandler.failure).toContain('unread')
  })

  it('captures private and squad memory scope semantics', () => {
    expect(contract.memory.privateMcpTools).toEqual(['remember', 'recall'])
    expect(contract.memory.squadMcpTools).toEqual(['squad_remember', 'squad_recall'])
    expect(contract.memory.privateScope).toBe('member:<member_id>')
    expect(contract.memory.squadScope).toBe('squad:<squad_id>')
    expect(contract.memory.squadAuthorization).toEqual({
      write: 'member-on-target-squad',
      read: 'observer-on-target-squad',
    })
    expect(contract.memory.defaultSquad).toContain('auth.boundAgentId')
    expect(contract.memory.vectorFilter).toEqual(['agentId', 'tenant'])
  })

  it('captures signed host lifecycle control semantics', () => {
    expect(contract.control.version).toBe('fleet-control.v1')
    expect(contract.control.api.path).toBe('/api/fleet/control')
    expect(contract.control.api.required).toEqual(['agent_id', 'verb'])
    expect(contract.control.consumer.read).toBe('POST /api/inbox/signed')
    expect(contract.control.consumer.nonceLedger).toBe('host-local')
    expect(contract.control.consumer.consumePolicy).toContain('consume-invalid')
    expect(contract.control.verbs.start).toContain('flight.mjs open')
    expect(contract.control.verbs.stop).toContain('flight.mjs close')
    expect(contract.control.verbs.restart).toContain('then')
    expect(contract.control.signedBytes).toEqual(['fleet-control.v1', 'agent_id', 'verb', 'nonce', 'ts'])
  })

  it('captures runtime presence check-in semantics', () => {
    expect(contract.presence.mcpTools).toEqual(['check_in'])
    expect(contract.presence.http).toBe('POST /api/fleet/checkin')
    expect(contract.presence.identitySource).toBe('authenticated-member-token')
    expect(contract.presence.bodyFieldsDescriptiveOnly).toEqual(['source', 'label'])
    expect(contract.presence.debounce).toBe('tenant-member-30s')
  })

  it('tracks the implemented task lifecycle states and gates', () => {
    expect(contract.tasks.mcpTools).toEqual(['task_create', 'task_list', 'task_board', 'task_update'])
    expect(contract.tasks.defaultSquad).toContain('auth.boundAgentId')
    expect(contract.tasks.authorization).toBe('member-on-target-squad')
    expect(contract.tasks.statuses).toEqual([
      'open',
      'in_progress',
      'blocked',
      'done',
      'review',
      'approved',
      'rejected',
    ])
    expect(contract.tasks.createStatuses).toEqual(['open', 'in_progress'])
    expect(contract.tasks.patchStatuses).toEqual(['open', 'in_progress', 'blocked', 'done', 'review'])
    expect(contract.tasks.verdictStatuses).toEqual(['approved', 'rejected'])
    expect(contract.tasks.doneWhenRequired).toBe(true)
    expect(contract.tasks.transitions.review).toEqual(['approved', 'rejected'])
    expect(contract.tasks.transitions.done).toEqual([])
  })

  it('tracks squad-scoped peer discovery semantics', () => {
    expect(contract.peerDiscovery.mcpTools).toEqual(['peers'])
    expect(contract.peerDiscovery.defaultSquad).toContain('auth.boundAgentId')
    expect(contract.peerDiscovery.authorization).toBe('observer-on-target-squad')
    expect(contract.peerDiscovery.scope).toBe('single-squad-roster')
    expect(contract.peerDiscovery.presence).toBe('latest-check-in-per-agent')
  })

  it('keeps Hermes and local smoke coverage on the same lifecycle language', () => {
    expect(contract.hermes.webhook.path).toBe('/im/webhook')
    expect(contract.hermes.webhook.secretHeader).toBe('X-Telegram-Bot-Api-Secret-Token')
    expect(contract.hermes.lifecycleName).toBe('Hermes IM task lifecycle')
    expect(contract.hermes.lifecycle).toEqual([
      'Telegram update',
      'IM webhook',
      'chat_id member mapping',
      'intent parsing',
      'capability gate',
      'createTask',
      'task.created',
      'reply',
    ])
    expect(contract.hermes.taskDoneWhen).toBe(
      'A task result or linked artifact provides evidence that the requested IM task is complete.',
    )

    const smoke = readFileSync(new URL('../scripts/local-browser-smoke.mjs', import.meta.url), 'utf8')
    expect(smoke).toContain('runtime-adapter/v1')
    expect(smoke).toContain('Hermes IM task lifecycle')
  })

  it('names the follow-up conformance suites adapters must pass', () => {
    expect(contract.conformance.localHarness).toMatchObject({
      script: 'scripts/local-runtime-conformance.mjs',
      npmScript: 'conformance:runtime:local',
      config: 'wrangler-local-test.toml',
      seed: 'scripts/local-test-seed.sql',
    })
    expect(contract.conformance.localHarness.covers).toEqual(
      expect.arrayContaining([
        'signed-attach',
        'bearer-inbox-send',
        'signed-inbox-consume',
        'consume-once',
        'signed-detach',
      ]),
    )
    expect(contract.conformance.planned).toEqual(
      expect.arrayContaining([
        'signed-attach',
        'signed-detach',
        'fleet-control',
        'inbox-idempotency',
        'hermes-im-task',
        'task-lifecycle',
        'result-receipts',
      ]),
    )
  })

  it('keeps the local runtime conformance harness wired to package scripts and seed fixtures', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> }
    const script = readFileSync(new URL('../scripts/local-runtime-conformance.mjs', import.meta.url), 'utf8')
    const seed = readFileSync(new URL('../scripts/local-test-seed.sql', import.meta.url), 'utf8')
    const scriptsReadme = readFileSync(new URL('../scripts/README.md', import.meta.url), 'utf8')

    expect(pkg.scripts['conformance:runtime:local']).toBe('node scripts/local-runtime-conformance.mjs')
    expect(script).toContain('runtime-adapter/v1')
    expect(script).toContain('/api/fleet/attach-signed')
    expect(script).toContain('/api/inbox/signed')
    expect(script).toContain('/api/fleet/detach-signed')
    expect(script).toContain('local-runtime-conformance-sender-token')
    expect(seed).toContain('agent-conformance')
    expect(seed).toContain('tok-conformance-sender')
    expect(seed).toContain('5hhsUxlkZWNACkMQjUFNIO1-e4bbFtTaLUd7_5L7sdU')
    expect(scriptsReadme).toContain('npm run conformance:runtime:local')
    expect(scriptsReadme).toContain('signed attach')
    expect(scriptsReadme).toContain('signed detach')
  })
})
