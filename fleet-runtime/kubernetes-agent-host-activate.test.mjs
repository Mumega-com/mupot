import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { pluginBundleHash } from './hermes-plugin-smoke.mjs'
import { buildCutoverPreflight } from '../scripts/kubernetes-agent-host-cutover-preflight.mjs'
import {
  evaluateActivationGuard,
  fetchConsumerFenceStatus,
  hostPodsForRollback,
  kubernetesDeploymentExecutionContractHash,
  runGuardedActivation,
  startPodOverlapMonitor,
} from '../scripts/kubernetes-agent-host-activate.mjs'

const temporaryDirectories = []

test.after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true })
})

function bookmark(resourceVersion) {
  return {
    type: 'BOOKMARK',
    object: {
      metadata: {
        resourceVersion,
        annotations: { 'k8s.io/initial-events-end': 'true' },
      },
    },
  }
}

function fakeKubectl(config) {
  const directory = mkdtempSync(join(tmpdir(), 'mupot-activate-kubectl-'))
  temporaryDirectories.push(directory)
  const executable = join(directory, 'kubectl')
  const source = `#!/usr/bin/env node
const config = ${JSON.stringify(config)}
const args = process.argv.slice(2)
const rawIndex = args.indexOf('--raw')
if (rawIndex >= 0) {
  const url = new URL(args[rawIndex + 1], 'https://kubernetes.invalid')
  const resourceVersion = url.searchParams.get('resourceVersion')
  const stream = resourceVersion === config.initialResourceVersion ? config.initialWatch : config.catchupWatch
  if (!stream) process.exit(42)
  for (const entry of stream.entries ?? []) {
    setTimeout(() => {
      process.stdout.write(entry.raw ?? (JSON.stringify(entry.event) + '\\n'))
    }, entry.afterMs ?? 0)
  }
  const lastDelay = Math.max(0, ...(stream.entries ?? []).map((entry) => entry.afterMs ?? 0))
  if (stream.hold !== false) {
    const hold = setInterval(() => {}, 1000)
    const stop = () => { clearInterval(hold); process.exit(0) }
    process.on('SIGTERM', stop)
    process.on('SIGINT', stop)
  } else {
    setTimeout(() => process.exit(stream.exitCode ?? 0), lastDelay + 20)
  }
} else if (args.includes('pods') && args.includes('-o') && args.includes('json')) {
  if (config.finalListExitCode) process.exit(config.finalListExitCode)
  process.stdout.write(JSON.stringify(config.finalPodList))
} else {
  process.exit(43)
}
`
  writeFileSync(executable, source, { mode: 0o700 })
  chmodSync(executable, 0o700)
  return executable
}

function monitorOptions(kubectlCommand) {
  return { kubectlCommand, startupTimeoutMs: 1_000, catchupTimeoutMs: 1_000, shutdownTimeoutMs: 500 }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function deployment(name, names, replicas, resourceVersion) {
  return {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name, uid: `${name}-uid`, resourceVersion, generation: 1 },
    spec: { replicas, template: { spec: { containers: names.map((value) => ({ name: value })) } } },
  }
}

function fixture() {
  const imageDigest = `sha256:${'a'.repeat(64)}`
  const pluginData = { 'plugin.yaml': 'name: mupot' }
  const plugin = {
    immutable: true, metadata: { name: 'dme-mupot-plugin-hash', uid: 'plugin-uid', resourceVersion: '9' }, data: pluginData,
  }
  const workloads = [
    deployment('dme-hermes', ['hermes', 'telegram-gateway'], 1, '10'),
    deployment('dme-hermes-agent-host', ['agent-host'], 0, '20'),
  ]
  workloads[1].spec.template.spec.containers[0].image = `registry.example/host@${imageDigest}`
  const expectedDeployment = structuredClone(workloads[1])
  const expectedDeploymentSha256 = sha256('rendered deployment fixture')
  const preflight = buildCutoverPreflight({
    namespace: 'dme-hermes', mode: 'activate', workloads, pods: [],
    clusterContext: 'test-cluster', namespaceUid: 'namespace-uid', now: new Date('2026-07-19T01:00:00Z'),
  })
  const smokeEvidence = {
    schema: 'mupot.kubernetes-hermes-plugin-smoke-evidence/v1', status: 'pass', image_digest: imageDigest,
    checks: [{ check: 'fixture', ok: true }], failure_codes: [],
    plugin_config_map: { name: plugin.metadata.name, uid: plugin.metadata.uid, resource_version: plugin.metadata.resourceVersion },
    plugin_bundle_sha256: pluginBundleHash(pluginData),
  }
  const releaseReceipt = {
    receipt_type: 'mupot-kubernetes-agent-host-receipt/v1', status: 'pass',
    target: { image_digest: imageDigest, agent_id: 'dme-hermes-k8s' },
    artifacts: [{ role: 'deployment', sha256: expectedDeploymentSha256 }],
    checks: [{ check: 'fixture', ok: true }], failure_codes: [],
  }
  return {
    workloads, plugin, preflight, smokeEvidence, releaseReceipt,
    expectedDeployment, expectedDeploymentSha256,
  }
}

function activationInput(value) {
  return {
    preflight: value.preflight,
    smokeEvidence: value.smokeEvidence,
    releaseReceipt: value.releaseReceipt,
    expectedDeployment: value.expectedDeployment,
    expectedDeploymentSha256: value.expectedDeploymentSha256,
  }
}

function readyHostPod(value) {
  return {
    kind: 'Pod', metadata: { name: 'host', labels: { 'app.kubernetes.io/name': 'mupot-agent-host' } },
    spec: structuredClone(value.expectedDeployment.spec.template.spec),
    status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
  }
}

function quietOverlapMonitor(overrides = {}) {
  return async () => ({
    stop: async () => ({ healthy: true, legacy_consumer_events: [], ...overrides }),
  })
}

function validFenceProof(overrides = {}) {
  return async () => ({
    agent_id: 'dme-hermes-k8s', mode: 'signed_only', generation: 7,
    key_fingerprint: 'f'.repeat(64), active_key_present: true, key_matches: true, ...overrides,
  })
}

test('guard binds exact resource versions and immutable plugin identity', () => {
  const value = fixture()
  const snapshot = {
    workloads: value.workloads, pods: [], pluginConfigMap: value.plugin,
    clusterContext: 'test-cluster', namespaceUid: 'namespace-uid',
  }
  assert.ok(evaluateActivationGuard({
    ...activationInput(value), snapshot,
    now: new Date('2026-07-19T01:00:01Z'),
  }).checks.every((entry) => entry.ok))
  const changed = structuredClone(snapshot)
  changed.workloads[0].metadata.resourceVersion = '11'
  assert.ok(evaluateActivationGuard({
    ...activationInput(value), snapshot: changed,
    now: new Date('2026-07-19T01:00:01Z'),
  }).checks.some((entry) => entry.code === 'cluster_snapshot_changed'))
})

test('guard binds nonempty ReplicaSet evidence into the live preflight', () => {
  const value = fixture()
  const replicaSet = {
    kind: 'ReplicaSet',
    metadata: {
      name: 'host-rs', uid: 'host-rs-uid', resourceVersion: '30', generation: 1,
      ownerReferences: [{
        kind: 'Deployment', name: 'dme-hermes-agent-host', uid: value.workloads[1].metadata.uid, controller: true,
      }],
    },
    spec: { template: { spec: { containers: [{ name: 'agent-host' }] } } },
  }
  value.preflight = buildCutoverPreflight({
    namespace: 'dme-hermes', mode: 'activate', workloads: value.workloads,
    replicaSets: [replicaSet], pods: [], clusterContext: 'test-cluster',
    namespaceUid: 'namespace-uid', now: new Date('2026-07-19T01:00:00Z'),
  })
  const snapshot = {
    workloads: value.workloads, replicaSets: [replicaSet], pods: [], pluginConfigMap: value.plugin,
    clusterContext: 'test-cluster', namespaceUid: 'namespace-uid',
  }
  assert.ok(evaluateActivationGuard({
    ...activationInput(value), snapshot,
    now: new Date('2026-07-19T01:00:01Z'),
  }).checks.every((entry) => entry.ok))
})

test('guard binds the passing release receipt and exact live Deployment contract', () => {
  const value = fixture()
  const snapshot = {
    workloads: value.workloads, pods: [], pluginConfigMap: value.plugin,
    clusterContext: 'test-cluster', namespaceUid: 'namespace-uid',
  }
  const changedReceipt = structuredClone(value.releaseReceipt)
  changedReceipt.artifacts[0].sha256 = sha256('different deployment')
  assert.ok(evaluateActivationGuard({
    ...activationInput(value), releaseReceipt: changedReceipt, snapshot,
    now: new Date('2026-07-19T01:00:01Z'),
  }).checks.some((entry) => entry.code === 'release_receipt_unbound'))

  for (const mutate of [
    (deployment) => { deployment.spec.template.spec.hostNetwork = true },
    (deployment) => { deployment.spec.template.spec.automountServiceAccountToken = true },
    (deployment) => { deployment.spec.template.spec.containers[0].securityContext = { privileged: true } },
    (deployment) => { deployment.spec.template.spec.containers[0].envFrom = [{ secretRef: { name: 'ambient' } }] },
  ]) {
    const changed = structuredClone(snapshot)
    mutate(changed.workloads[1])
    const result = evaluateActivationGuard({
      ...activationInput(value), snapshot: changed,
      now: new Date('2026-07-19T01:00:01Z'),
    })
    assert.ok(result.checks.some((entry) => entry.code === 'live_deployment_contract_changed'))
  }

  const binaryPlugin = structuredClone(snapshot)
  binaryPlugin.pluginConfigMap.binaryData = { 'shadow.py': 'cHJpbnQoImhpIik=' }
  assert.ok(evaluateActivationGuard({
    ...activationInput(value), snapshot: binaryPlugin,
    now: new Date('2026-07-19T01:00:01Z'),
  }).checks.some((entry) => entry.code === 'immutable_plugin_identity_changed'))
})

test('Deployment execution hash ignores object key order and replica count only', () => {
  const value = fixture()
  const reordered = {
    kind: value.expectedDeployment.kind,
    apiVersion: value.expectedDeployment.apiVersion,
    spec: {
      template: value.expectedDeployment.spec.template,
      replicas: 99,
    },
    metadata: {
      labels: value.expectedDeployment.metadata.labels,
      name: value.expectedDeployment.metadata.name,
    },
  }
  assert.equal(
    kubernetesDeploymentExecutionContractHash(reordered),
    kubernetesDeploymentExecutionContractHash(value.expectedDeployment),
  )
})

test('post-activation mismatch automatically scales the Host back to zero', async () => {
  const value = fixture()
  const before = {
    workloads: value.workloads, pods: [], pluginConfigMap: value.plugin,
    clusterContext: 'test-cluster', namespaceUid: 'namespace-uid',
  }
  const after = structuredClone(before)
  after.workloads[1].spec.replicas = 1
  after.workloads[1].metadata.resourceVersion = '21'
  after.workloads[1].status = { availableReplicas: 1 }
  after.workloads[0].spec.template.spec.containers.push({ name: 'mupot-subscriber' })
  after.pods = [readyHostPod(value)]
  const scales = []
  const rollbackOrder = []
  let reads = 0
  const receipt = await runGuardedActivation(activationInput(value), {
    now: () => new Date('2026-07-19T01:00:01Z'),
    snapshot: async () => reads++ === 0 ? before : after,
    scale: async (replicas, resourceVersion) => {
      scales.push({ replicas, resourceVersion })
      if (replicas === 0) rollbackOrder.push('scaled-zero')
    },
    waitStopped: async () => { rollbackOrder.push('zero-pods-confirmed') },
    waitReady: async () => {},
    startOverlapMonitor: quietOverlapMonitor(),
    verifyConsumerFence: validFenceProof(),
  })
  assert.equal(receipt.status, 'fail')
  assert.equal(receipt.rollback_performed, true)
  assert.deepEqual(scales, [{ replicas: 1, resourceVersion: '20' }, { replicas: 0, resourceVersion: undefined }])
  assert.deepEqual(rollbackOrder, ['scaled-zero', 'zero-pods-confirmed'])
  assert.ok(receipt.failure_codes.includes('legacy_consumer_returned'))
})

test('guarded activation passes only after one ready Host pod is observed', async () => {
  const value = fixture()
  const before = {
    workloads: value.workloads, pods: [], pluginConfigMap: value.plugin,
    clusterContext: 'test-cluster', namespaceUid: 'namespace-uid',
  }
  const after = structuredClone(before)
  after.workloads[1].spec.replicas = 1
  after.workloads[1].metadata.resourceVersion = '21'
  after.workloads[1].status = { availableReplicas: 1 }
  after.pods = [readyHostPod(value)]
  let reads = 0
  const scales = []
  const receipt = await runGuardedActivation(activationInput(value), {
    now: () => new Date('2026-07-19T01:00:01Z'),
    snapshot: async () => reads++ === 0 ? before : after,
    scale: async (replicas, resourceVersion) => { scales.push({ replicas, resourceVersion }) },
    waitStopped: async () => {},
    waitReady: async () => {},
    startOverlapMonitor: quietOverlapMonitor(),
    verifyConsumerFence: validFenceProof(),
  })
  assert.equal(receipt.status, 'pass')
  assert.equal(receipt.rollback_performed, false)
  assert.deepEqual(scales, [{ replicas: 1, resourceVersion: '20' }])
  assert.deepEqual(receipt.failure_codes, [])
})

test('activation rolls back when the fence generation or pinned key changes during startup', async () => {
  const value = fixture()
  const before = {
    workloads: value.workloads, pods: [], pluginConfigMap: value.plugin,
    clusterContext: 'test-cluster', namespaceUid: 'namespace-uid',
  }
  const after = structuredClone(before)
  after.workloads[1].spec.replicas = 1
  after.workloads[1].metadata.resourceVersion = '21'
  after.workloads[1].status = { availableReplicas: 1 }
  after.pods = [readyHostPod(value)]
  let snapshots = 0
  let fences = 0
  const scales = []
  const receipt = await runGuardedActivation(activationInput(value), {
    now: () => new Date('2026-07-19T01:00:01Z'),
    snapshot: async () => snapshots++ === 0 ? before : after,
    scale: async (replicas, resourceVersion) => { scales.push({ replicas, resourceVersion }) },
    waitStopped: async () => {},
    waitReady: async () => {},
    startOverlapMonitor: quietOverlapMonitor(),
    verifyConsumerFence: async () => fences++ === 0
      ? validFenceProof()()
      : validFenceProof({ generation: 8, key_fingerprint: 'e'.repeat(64) })(),
  })
  assert.equal(receipt.status, 'fail')
  assert.equal(receipt.rollback_performed, true)
  assert.deepEqual(scales, [{ replicas: 1, resourceVersion: '20' }, { replicas: 0, resourceVersion: undefined }])
  assert.ok(receipt.failure_codes.includes('consumer_fence_changed_during_activation'))
})

test('a scale-up that applies then throws is always rolled back to zero', async () => {
  const value = fixture()
  const before = {
    workloads: value.workloads, pods: [], pluginConfigMap: value.plugin,
    clusterContext: 'test-cluster', namespaceUid: 'namespace-uid',
  }
  const scales = []
  const receipt = await runGuardedActivation(activationInput(value), {
    now: () => new Date('2026-07-19T01:00:01Z'),
    snapshot: async () => before,
    scale: async (replicas, resourceVersion) => {
      scales.push({ replicas, resourceVersion })
      if (replicas === 1) throw new Error('client timed out after applying scale')
    },
    waitStopped: async () => {},
    waitReady: async () => {},
    startOverlapMonitor: quietOverlapMonitor(),
    verifyConsumerFence: validFenceProof(),
  })
  assert.equal(receipt.status, 'fail')
  assert.equal(receipt.rollback_performed, true)
  assert.deepEqual(scales, [{ replicas: 1, resourceVersion: '20' }, { replicas: 0, resourceVersion: undefined }])
})

test('rollback pod discovery follows Deployment ownership even after label and container drift', () => {
  const deployment = { metadata: { name: 'dme-hermes-agent-host', uid: 'host-deployment-uid' } }
  const replicaSets = [{
    metadata: {
      name: 'host-rs', uid: 'host-rs-uid',
      ownerReferences: [{ kind: 'Deployment', name: 'dme-hermes-agent-host', uid: 'host-deployment-uid', controller: true }],
    },
  }]
  const drifted = {
    metadata: {
      name: 'mutated-host-pod', labels: {},
      ownerReferences: [{ kind: 'ReplicaSet', name: 'host-rs', uid: 'host-rs-uid', controller: true }],
    },
    spec: { containers: [{ name: 'mutated-container' }] },
  }
  assert.deepEqual(hostPodsForRollback({ deployment, replicaSets, pods: [drifted] }), [drifted])
})

test('admitted Host pod mutation automatically rolls activation back to zero', async () => {
  const value = fixture()
  const before = {
    workloads: value.workloads, pods: [], pluginConfigMap: value.plugin,
    clusterContext: 'test-cluster', namespaceUid: 'namespace-uid',
  }
  const after = structuredClone(before)
  after.workloads[1].spec.replicas = 1
  after.workloads[1].metadata.resourceVersion = '21'
  after.workloads[1].status = { availableReplicas: 1 }
  const pod = readyHostPod(value)
  pod.spec.initContainers = [{ name: 'unexpected', image: 'busybox:latest' }]
  pod.spec.hostPID = true
  after.pods = [pod]
  let reads = 0
  const scales = []
  const receipt = await runGuardedActivation(activationInput(value), {
    now: () => new Date('2026-07-19T01:00:01Z'),
    snapshot: async () => reads++ === 0 ? before : after,
    scale: async (replicas, resourceVersion) => { scales.push({ replicas, resourceVersion }) },
    waitStopped: async () => {},
    waitReady: async () => {},
    startOverlapMonitor: quietOverlapMonitor(),
    verifyConsumerFence: validFenceProof(),
  })
  assert.equal(receipt.status, 'fail')
  assert.equal(receipt.rollback_performed, true)
  assert.deepEqual(scales, [{ replicas: 1, resourceVersion: '20' }, { replicas: 0, resourceVersion: undefined }])
  assert.ok(receipt.failure_codes.includes('host_pod_admission_contract_changed'))
})

test('a second Host-owned pod cannot hide behind mutated labels and container names', async () => {
  const value = fixture()
  const before = {
    workloads: value.workloads, replicaSets: [], pods: [], pluginConfigMap: value.plugin,
    clusterContext: 'test-cluster', namespaceUid: 'namespace-uid',
  }
  const after = structuredClone(before)
  after.workloads[1].spec.replicas = 1
  after.workloads[1].metadata.resourceVersion = '21'
  after.workloads[1].status = { availableReplicas: 1 }
  const replicaSet = {
    metadata: {
      name: 'host-rs', uid: 'host-rs-uid',
      ownerReferences: [{
        kind: 'Deployment', name: 'dme-hermes-agent-host', uid: value.workloads[1].metadata.uid, controller: true,
      }],
    },
  }
  const ready = readyHostPod(value)
  ready.metadata.ownerReferences = [{
    kind: 'ReplicaSet', name: replicaSet.metadata.name, uid: replicaSet.metadata.uid, controller: true,
  }]
  const hidden = structuredClone(ready)
  hidden.metadata.name = 'hidden-host'
  hidden.metadata.labels = {}
  hidden.spec.containers[0].name = 'mutated-container'
  after.replicaSets = [replicaSet]
  after.pods = [ready, hidden]
  let reads = 0
  const scales = []
  const receipt = await runGuardedActivation(activationInput(value), {
    now: () => new Date('2026-07-19T01:00:01Z'),
    snapshot: async () => reads++ === 0 ? before : after,
    scale: async (replicas, resourceVersion) => { scales.push({ replicas, resourceVersion }) },
    waitStopped: async () => {},
    waitReady: async () => {},
    startOverlapMonitor: quietOverlapMonitor(),
    verifyConsumerFence: validFenceProof(),
  })
  assert.equal(receipt.status, 'fail')
  assert.equal(receipt.rollback_performed, true)
  assert.deepEqual(scales, [{ replicas: 1, resourceVersion: '20' }, { replicas: 0, resourceVersion: undefined }])
  assert.ok(receipt.failure_codes.includes('host_activation_incomplete'))
})

test('transient legacy pod overlap automatically rolls activation back even when final state is clean', async () => {
  const value = fixture()
  const before = {
    workloads: value.workloads, pods: [], pluginConfigMap: value.plugin,
    clusterContext: 'test-cluster', namespaceUid: 'namespace-uid',
  }
  const after = structuredClone(before)
  after.workloads[1].spec.replicas = 1
  after.workloads[1].metadata.resourceVersion = '21'
  after.workloads[1].status = { availableReplicas: 1 }
  after.pods = [readyHostPod(value)]
  let reads = 0
  const scales = []
  const receipt = await runGuardedActivation(activationInput(value), {
    now: () => new Date('2026-07-19T01:00:01Z'),
    snapshot: async () => reads++ === 0 ? before : after,
    startOverlapMonitor: quietOverlapMonitor({
      legacy_consumer_events: [{
        event_type: 'ADDED', pod_uid: 'legacy-pod-uid', pod_name: 'transient-legacy', resource_version: '25',
      }],
    }),
    verifyConsumerFence: validFenceProof(),
    scale: async (replicas, resourceVersion) => { scales.push({ replicas, resourceVersion }) },
    waitStopped: async () => {},
    waitReady: async () => {},
  })
  assert.equal(receipt.status, 'fail')
  assert.equal(receipt.rollback_performed, true)
  assert.deepEqual(scales, [{ replicas: 1, resourceVersion: '20' }, { replicas: 0, resourceVersion: undefined }])
  assert.ok(receipt.failure_codes.includes('transient_consumer_overlap_or_monitor_failure'))
})

test('activation refuses to scale when the live Mupot inbox fence is open or stale', async () => {
  const value = fixture()
  const before = {
    workloads: value.workloads, pods: [], pluginConfigMap: value.plugin,
    clusterContext: 'test-cluster', namespaceUid: 'namespace-uid',
  }
  const scales = []
  const receipt = await runGuardedActivation(activationInput(value), {
    now: () => new Date('2026-07-19T01:00:01Z'),
    snapshot: async () => before,
    verifyConsumerFence: validFenceProof({ mode: 'bearer_only', generation: 0 }),
    startOverlapMonitor: () => { throw new Error('monitor must not start') },
    scale: async (replicas, resourceVersion) => { scales.push({ replicas, resourceVersion }) },
    waitReady: async () => {},
  })
  assert.equal(receipt.status, 'fail')
  assert.deepEqual(scales, [])
  assert.ok(receipt.failure_codes.includes('consumer_fence_not_signed_only'))
})

test('live fence query validates a bounded redacted agent-bound response', async () => {
  const calls = []
  const result = await fetchConsumerFenceStatus({
    baseUrl: 'https://pot.example', token: 'secret-token-value',
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return new Response(JSON.stringify({
        ok: true, tool: 'inbox_consumer_status',
        result: {
          agent_id: 'dme-hermes-k8s', mode: 'signed_only', generation: 7,
          key_fingerprint: 'f'.repeat(64),
          active_key_present: true, key_matches: true,
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  assert.deepEqual(result, {
    agent_id: 'dme-hermes-k8s', mode: 'signed_only', generation: 7,
    key_fingerprint: 'f'.repeat(64),
    active_key_present: true, key_matches: true,
  })
  assert.equal(calls[0].url, 'https://pot.example/actions/inbox_consumer_status')
  assert.equal(calls[0].options.redirect, 'error')
  assert.equal(calls[0].options.body, '{}')
  assert.ok(!JSON.stringify(result).includes('secret-token-value'))
})

test('live fence query rejects malformed, oversized, and non-2xx responses', async () => {
  const base = { baseUrl: 'https://pot.example', token: 'secret-token-value' }
  await assert.rejects(fetchConsumerFenceStatus({
    ...base, fetchImpl: async () => new Response('{}', { status: 409 }),
  }), /HTTP 409/)
  await assert.rejects(fetchConsumerFenceStatus({
    ...base, fetchImpl: async () => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }),
  }), /response invalid/)
  await assert.rejects(fetchConsumerFenceStatus({
    ...base, fetchImpl: async () => new Response('x', { status: 200, headers: { 'content-length': '999999' } }),
  }), /too large/)
})

test('automatic rollback is incomplete when zero Host pods are not confirmed', async () => {
  const value = fixture()
  const before = {
    workloads: value.workloads, pods: [], pluginConfigMap: value.plugin,
    clusterContext: 'test-cluster', namespaceUid: 'namespace-uid',
  }
  const after = structuredClone(before)
  after.workloads[1].spec.replicas = 1
  after.workloads[1].metadata.resourceVersion = '21'
  after.workloads[1].status = { availableReplicas: 1 }
  after.pods = [readyHostPod(value)]
  after.workloads[0].spec.template.spec.containers.push({ name: 'mupot-subscriber' })
  let reads = 0
  const receipt = await runGuardedActivation(activationInput(value), {
    now: () => new Date('2026-07-19T01:00:01Z'),
    snapshot: async () => reads++ === 0 ? before : after,
    scale: async () => {},
    waitReady: async () => {},
    waitStopped: async () => { throw new Error('host pods remain') },
    startOverlapMonitor: quietOverlapMonitor(),
    verifyConsumerFence: validFenceProof(),
  })

  assert.equal(receipt.status, 'fail')
  assert.equal(receipt.rollback_performed, false)
  assert.ok(receipt.failure_codes.includes('automatic_rollback_failed'))
})

test('spawned watch waits for opaque-RV bookmarks and captures events arriving during final catch-up', async () => {
  const initialResourceVersion = 'rv/start:opaque-A'
  const finalResourceVersion = 'rv/final:opaque-Z'
  const kubectlCommand = fakeKubectl({
    initialResourceVersion,
    finalPodList: { metadata: { resourceVersion: finalResourceVersion }, items: [] },
    initialWatch: {
      entries: [
        { afterMs: 80, event: bookmark('rv/initial-synced') },
        {
          afterMs: 180,
          event: {
            type: 'ADDED',
            object: {
              metadata: { uid: 'legacy-late-uid', name: 'legacy-late', resourceVersion: 'rv/late:event' },
              spec: { containers: [{ name: 'mupot-subscriber' }] },
            },
          },
        },
      ],
    },
    catchupWatch: { entries: [{ afterMs: 240, event: bookmark('rv/final-synced') }] },
  })

  const startupAt = Date.now()
  const monitor = await startPodOverlapMonitor(
    { podListResourceVersion: initialResourceVersion },
    monitorOptions(kubectlCommand),
  )
  assert.ok(Date.now() - startupAt >= 50, 'monitor must wait for the delayed server bookmark')

  const stopAt = Date.now()
  const observation = await monitor.stop()
  assert.ok(Date.now() - stopAt >= 120, 'stop must wait for final-list catch-up bookmark')
  assert.equal(observation.healthy, true)
  assert.equal(observation.resource_version, initialResourceVersion)
  assert.equal(observation.final_resource_version, finalResourceVersion)
  assert.equal(observation.catchup_resource_version, 'rv/final-synced')
  assert.deepEqual(observation.failure_codes, [])
  assert.ok(observation.legacy_consumer_events.some((event) => event.pod_uid === 'legacy-late-uid'))
})

test('spawned watch captures a legacy event visible only to the catch-up watch', async () => {
  const initialResourceVersion = 'rv-catchup-only-start'
  const kubectlCommand = fakeKubectl({
    initialResourceVersion,
    finalPodList: { metadata: { resourceVersion: 'rv-catchup-only-final' }, items: [] },
    initialWatch: { entries: [{ event: bookmark('rv-initial-ready') }] },
    catchupWatch: {
      entries: [{
        event: {
          type: 'ADDED',
          object: {
            metadata: { uid: 'catchup-legacy-uid', name: 'catchup-legacy', resourceVersion: 'rv-catchup-event' },
            spec: { containers: [{ name: 'mupot-subscriber' }] },
          },
        },
      }, { afterMs: 40, event: bookmark('rv-catchup-ready') }],
    },
  })
  const monitor = await startPodOverlapMonitor(
    { podListResourceVersion: initialResourceVersion }, monitorOptions(kubectlCommand),
  )
  const observation = await monitor.stop()
  assert.equal(observation.healthy, true)
  assert.ok(observation.legacy_consumer_events.some((event) => event.pod_uid === 'catchup-legacy-uid'))
})

test('spawned watch fails closed on catch-up compaction, timeout, and final-list failure', async () => {
  const cases = [
    {
      name: 'compaction', expected: 'pod_watch_compacted',
      config: {
        finalPodList: { metadata: { resourceVersion: 'rv-final-410' }, items: [] },
        catchupWatch: { hold: false, entries: [{ event: { type: 'ERROR', object: { code: 410, reason: 'Expired' } } }] },
      },
    },
    {
      name: 'timeout', expected: 'pod_watch_catchup_timeout',
      config: {
        finalPodList: { metadata: { resourceVersion: 'rv-final-timeout' }, items: [] },
        catchupWatch: { entries: [] },
      },
    },
    {
      name: 'final-list', expected: 'pod_watch_final_catchup_failed',
      config: { finalListExitCode: 44, finalPodList: null, catchupWatch: { entries: [] } },
    },
  ]
  for (const scenario of cases) {
    const initialResourceVersion = `rv-${scenario.name}-start`
    const kubectlCommand = fakeKubectl({
      initialResourceVersion,
      initialWatch: { entries: [{ event: bookmark(`rv-${scenario.name}-ready`) }] },
      ...scenario.config,
    })
    const monitor = await startPodOverlapMonitor(
      { podListResourceVersion: initialResourceVersion },
      { ...monitorOptions(kubectlCommand), catchupTimeoutMs: 500 },
    )
    const observation = await monitor.stop()
    assert.equal(observation.healthy, false)
    assert.ok(observation.failure_codes.includes(scenario.expected), JSON.stringify(observation))
  }
})

test('spawned watch fails closed on a trailing partial JSON event', async () => {
  const initialResourceVersion = 'rv-initial-partial'
  const kubectlCommand = fakeKubectl({
    initialResourceVersion,
    finalPodList: { metadata: { resourceVersion: 'rv-final-partial' }, items: [] },
    initialWatch: {
      entries: [
        { event: bookmark('rv-started-partial') },
        { afterMs: 40, raw: '{"type":"ADDED"' },
      ],
    },
    catchupWatch: { entries: [{ afterMs: 100, event: bookmark('rv-caught-partial') }] },
  })
  const monitor = await startPodOverlapMonitor(
    { podListResourceVersion: initialResourceVersion },
    monitorOptions(kubectlCommand),
  )

  const observation = await monitor.stop()
  assert.equal(observation.healthy, false)
  assert.ok(observation.failure_codes.includes('pod_watch_partial_json'))
})

test('spawned watch reports Kubernetes ERROR and compaction events before activation', async () => {
  for (const [code, expected] of [[500, 'pod_watch_error'], [410, 'pod_watch_compacted']]) {
    const initialResourceVersion = `rv-error-${code}`
    const kubectlCommand = fakeKubectl({
      initialResourceVersion,
      finalPodList: { metadata: { resourceVersion: `rv-final-${code}` }, items: [] },
      initialWatch: {
        hold: false,
        entries: [{ event: { type: 'ERROR', object: { code, reason: code === 410 ? 'Expired' : 'InternalError' } } }],
      },
      catchupWatch: { entries: [] },
    })

    await assert.rejects(
      startPodOverlapMonitor(
        { podListResourceVersion: initialResourceVersion },
        monitorOptions(kubectlCommand),
      ),
      new RegExp(expected),
    )
  }
})

test('spawned watch times out before activation when no startup bookmark arrives', async () => {
  const initialResourceVersion = 'rv-startup-timeout'
  const kubectlCommand = fakeKubectl({
    initialResourceVersion,
    finalPodList: { metadata: { resourceVersion: 'rv-never-used' }, items: [] },
    initialWatch: { entries: [] },
    catchupWatch: { entries: [] },
  })

  await assert.rejects(
    startPodOverlapMonitor(
      { podListResourceVersion: initialResourceVersion },
      { ...monitorOptions(kubectlCommand), startupTimeoutMs: 500 },
    ),
    /pod_watch_startup_timeout/,
  )
})
