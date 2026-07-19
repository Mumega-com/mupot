import test from 'node:test'
import assert from 'node:assert/strict'

import { buildCutoverPreflight } from '../scripts/kubernetes-agent-host-cutover-preflight.mjs'

const SEED_PROFILE = {
  args: ['if [ ! -f /opt/data/config.yaml ]; then\n\n  cp /profile/config.yaml /opt/data/config.yaml.next &&\n  chmod 0640 /opt/data/config.yaml.next &&\n  mv -f /opt/data/config.yaml.next /opt/data/config.yaml;\nfi && if [ ! -f /opt/data/SOUL.md ]; then\n\n  cp /profile/SOUL.md /opt/data/SOUL.md.next &&\n  chmod 0640 /opt/data/SOUL.md.next &&\n  mv -f /opt/data/SOUL.md.next /opt/data/SOUL.md;\nfi'],
  command: ['/bin/sh', '-c'],
  image: 'nousresearch/hermes-agent@sha256:8d56cd839ad76b0fc2c9202f39a7ffe1b464c247059a17bc3c72ba6b4ae57616',
  imagePullPolicy: 'IfNotPresent', name: 'seed-profile',
  resources: { limits: { cpu: '100m', memory: '128Mi' }, requests: { cpu: '10m', memory: '32Mi' } },
  securityContext: {
    allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] },
    runAsGroup: 10000, runAsNonRoot: true, runAsUser: 10000,
  },
  terminationMessagePath: '/dev/termination-log', terminationMessagePolicy: 'File',
  volumeMounts: [
    { mountPath: '/opt/data', name: 'data' },
    { mountPath: '/profile', name: 'profile', readOnly: true },
  ],
}

function seedProfile(overrides = {}) {
  return { ...structuredClone(SEED_PROFILE), ...overrides }
}

function deployment(name, names, replicas = 1) {
  return {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name, uid: `${name}-uid`, resourceVersion: '12', generation: 3 },
    spec: { replicas, template: { spec: { containers: names.map((value) => ({ name: value })) } } },
  }
}

function withInit(item, names) {
  item.spec.template.spec.initContainers = names.map((name) => name === 'seed-profile' ? seedProfile() : { name })
  return item
}

function sourcePod(names = ['hermes', 'telegram-gateway']) {
  return {
    kind: 'Pod',
    metadata: { name: 'dme-hermes-source', labels: { 'app.kubernetes.io/name': 'dme-hermes' } },
    spec: {
      initContainers: [seedProfile()],
      containers: names.map((name) => ({ name })),
    },
  }
}

test('passes only after the legacy subscriber is absent and the Host is inert', () => {
  const receipt = buildCutoverPreflight({
    namespace: 'dme-hermes',
    workloads: [deployment('dme-hermes', ['hermes', 'telegram-gateway']), deployment('dme-hermes-agent-host', ['agent-host'], 0)],
    pods: [],
    now: new Date('2026-07-19T00:00:00Z'),
    clusterContext: 'test-cluster', namespaceUid: 'namespace-uid',
  })
  assert.equal(receipt.status, 'pass')
  assert.deepEqual(receipt.failure_codes, [])
  assert.match(receipt.evidence.workloads_sha256, /^[a-f0-9]{64}$/)
})

test('preserves the DME seed-profile initializer without admitting extra runtime containers', () => {
  const seeded = buildCutoverPreflight({
    namespace: 'dme-hermes',
    workloads: [
      withInit(deployment('dme-hermes', ['hermes', 'telegram-gateway']), ['seed-profile']),
      deployment('dme-hermes-agent-host', ['agent-host'], 0),
    ],
    pods: [], clusterContext: 'test-cluster', namespaceUid: 'namespace-uid',
  })
  assert.equal(seeded.status, 'pass')

  for (const source of [
    withInit(deployment('dme-hermes', ['hermes', 'telegram-gateway']), ['unexpected-init']),
    {
      ...withInit(deployment('dme-hermes', ['hermes', 'telegram-gateway']), ['seed-profile']),
      spec: { template: { spec: {
        containers: [{ name: 'hermes' }, { name: 'telegram-gateway' }],
        initContainers: [seedProfile({ image: 'attacker.invalid/seed:latest' })],
      } } },
    },
    {
      ...withInit(deployment('dme-hermes', ['hermes', 'telegram-gateway']), ['seed-profile']),
      spec: { template: { spec: {
        containers: [{ name: 'hermes' }, { name: 'telegram-gateway' }],
        initContainers: [seedProfile({ restartPolicy: 'Always' })],
      } } },
    },
    {
      ...deployment('dme-hermes', ['hermes', 'telegram-gateway']),
      spec: { template: { spec: {
        containers: [{ name: 'hermes' }, { name: 'telegram-gateway' }],
        ephemeralContainers: [{ name: 'debug-shell' }],
      } } },
    },
  ]) {
    const receipt = buildCutoverPreflight({
      namespace: 'dme-hermes', workloads: [source], pods: [],
      clusterContext: 'test-cluster', namespaceUid: 'namespace-uid',
    })
    assert.ok(receipt.failure_codes.includes('source_runtime_changed'))
  }
})

test('rejects admission-injected containers on the live DME pod', () => {
  for (const pod of [
    sourcePod(['hermes', 'telegram-gateway', 'injected-sidecar']),
    {
      ...sourcePod(),
      spec: { ...sourcePod().spec, ephemeralContainers: [{ name: 'debug-shell' }] },
    },
    {
      ...sourcePod(),
      spec: { ...sourcePod().spec, initContainers: [seedProfile({ restartPolicy: 'Always' })] },
    },
  ]) {
    const receipt = buildCutoverPreflight({
      namespace: 'dme-hermes',
      workloads: [deployment('dme-hermes', ['hermes', 'telegram-gateway'])],
      pods: [pod], clusterContext: 'test-cluster', namespaceUid: 'namespace-uid',
    })
    assert.ok(receipt.failure_codes.includes('source_runtime_changed'))
  }
})

test('fails when any workload or pod retains the legacy consumer or a Host pod exists', () => {
  const legacy = buildCutoverPreflight({
    namespace: 'dme-hermes',
    workloads: [deployment('dme-hermes', ['hermes', 'telegram-gateway', 'mupot-subscriber'])],
    pods: [],
    clusterContext: 'test-cluster', namespaceUid: 'namespace-uid',
  })
  assert.ok(legacy.failure_codes.includes('legacy_subscriber_present'))
  const hostPod = {
    kind: 'Pod', metadata: { name: 'host', labels: { 'app.kubernetes.io/name': 'mupot-agent-host' } },
    spec: { containers: [{ name: 'agent-host' }] },
  }
  const active = buildCutoverPreflight({
    namespace: 'dme-hermes', workloads: [deployment('dme-hermes', ['hermes', 'telegram-gateway'])], pods: [hostPod],
    clusterContext: 'test-cluster', namespaceUid: 'namespace-uid',
  })
  assert.ok(active.failure_codes.includes('agent_host_not_inert'))
})

test('follows Deployment ownership when Host pod labels and containers drift', () => {
  const host = deployment('dme-hermes-agent-host', ['agent-host'], 0)
  const replicaSet = {
    kind: 'ReplicaSet',
    metadata: {
      name: 'host-rs', uid: 'host-rs-uid', resourceVersion: '13', generation: 1,
      ownerReferences: [{
        kind: 'Deployment', name: host.metadata.name, uid: host.metadata.uid, controller: true,
      }],
    },
    spec: { template: { spec: { containers: [{ name: 'mutated-template' }] } } },
  }
  const driftedPod = {
    kind: 'Pod',
    metadata: {
      name: 'drifted-host', uid: 'host-pod-uid', resourceVersion: '14', labels: {},
      ownerReferences: [{
        kind: 'ReplicaSet', name: replicaSet.metadata.name, uid: replicaSet.metadata.uid, controller: true,
      }],
    },
    spec: { containers: [{ name: 'mutated-container' }] },
  }
  const receipt = buildCutoverPreflight({
    namespace: 'dme-hermes',
    workloads: [deployment('dme-hermes', ['hermes', 'telegram-gateway']), host],
    replicaSets: [replicaSet], pods: [driftedPod],
    clusterContext: 'test-cluster', namespaceUid: 'namespace-uid',
  })
  assert.equal(receipt.status, 'fail')
  assert.ok(receipt.failure_codes.includes('agent_host_not_inert'))
  assert.equal(receipt.evidence.replica_set_count, 1)
})

test('proves both rollback phases without permitting overlapping consumers', () => {
  const now = new Date('2026-07-19T00:00:00Z')
  const ready = buildCutoverPreflight({
    namespace: 'dme-hermes', mode: 'rollback-ready',
    workloads: [deployment('dme-hermes', ['hermes', 'telegram-gateway'])], pods: [], now,
    clusterContext: 'test-cluster', namespaceUid: 'namespace-uid',
  })
  assert.equal(ready.status, 'pass')
  assert.equal(ready.mode, 'rollback-ready')

  const restored = withInit(
    deployment('dme-hermes', ['hermes', 'telegram-gateway', 'mupot-subscriber']),
    ['seed-profile'],
  )
  restored.status = { availableReplicas: 1, readyReplicas: 1, updatedReplicas: 1 }
  const complete = buildCutoverPreflight({
    namespace: 'dme-hermes', mode: 'rollback-complete', workloads: [restored],
    consumerFence: {
      agent_id: 'dme-hermes-k8s', mode: 'bearer_only', generation: 8,
      key_fingerprint: null, active_key_present: true, key_matches: true,
    },
    pods: [{
      kind: 'Pod', metadata: { name: 'dme-hermes-restored', labels: { 'app.kubernetes.io/name': 'dme-hermes' } },
      spec: {
        initContainers: [seedProfile()],
        containers: [{ name: 'hermes' }, { name: 'telegram-gateway' }, { name: 'mupot-subscriber' }],
      },
      status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
    }], now,
    clusterContext: 'test-cluster', namespaceUid: 'namespace-uid',
  })
  assert.equal(complete.status, 'pass')
  assert.equal(complete.evidence.agent_host_inert, true)
  assert.equal(complete.evidence.legacy_subscriber_restored, true)

  const stillSigned = buildCutoverPreflight({
    namespace: 'dme-hermes', mode: 'rollback-complete', workloads: [restored],
    consumerFence: {
      agent_id: 'dme-hermes-k8s', mode: 'signed_only', generation: 7,
      key_fingerprint: 'f'.repeat(64), active_key_present: true, key_matches: true,
    },
    pods: complete.evidence.pods.map((pod) => ({
      kind: pod.kind,
      metadata: { name: pod.name, labels: { 'app.kubernetes.io/name': 'dme-hermes' } },
      spec: { containers: pod.containers.map((name) => ({ name })) },
      status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
    })),
    now, clusterContext: 'test-cluster', namespaceUid: 'namespace-uid',
  })
  assert.equal(stillSigned.status, 'fail')
  assert.ok(stillSigned.failure_codes.includes('consumer_fence_not_bearer_only'))

  const activeHostPod = {
    kind: 'Pod', metadata: { name: 'host', labels: { 'app.kubernetes.io/name': 'mupot-agent-host' } },
    spec: { containers: [{ name: 'agent-host' }] },
  }
  const overlapping = buildCutoverPreflight({
    namespace: 'dme-hermes', mode: 'rollback-complete',
    workloads: [restored, deployment('dme-hermes-agent-host', ['agent-host'], 1)], pods: [activeHostPod], now,
    consumerFence: {
      agent_id: 'dme-hermes-k8s', mode: 'bearer_only', generation: 8,
      key_fingerprint: null, active_key_present: true, key_matches: true,
    },
    clusterContext: 'test-cluster', namespaceUid: 'namespace-uid',
  })
  assert.equal(overlapping.status, 'fail')
  assert.ok(overlapping.failure_codes.includes('agent_host_not_inert'))
})
