function podSpecFor(item) {
  if (item?.kind === 'CronJob') return item?.spec?.jobTemplate?.spec?.template?.spec
  if (item?.kind === 'Pod') return item?.spec
  return item?.spec?.template?.spec
}

function exactNames(containers, expected) {
  const names = (containers ?? []).map((container) => container?.name).sort()
  return JSON.stringify(names) === JSON.stringify([...expected].sort())
}

const APPROVED_SEED_PROFILE = {
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

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]))
}

function approvedSeedProfile(container) {
  return JSON.stringify(canonicalValue(container)) === JSON.stringify(canonicalValue(APPROVED_SEED_PROFILE))
}

function ownedBy(item, kind, name, uid) {
  return (item?.metadata?.ownerReferences ?? []).some((owner) =>
    owner?.kind === kind && owner?.name === name && owner?.uid === uid && owner?.controller === true)
}

export function dmeSourcePods({ deployment, replicaSets = [], pods = [] }) {
  const deploymentName = deployment?.metadata?.name
  const deploymentUid = deployment?.metadata?.uid
  const ownedReplicaSets = new Set(
    deploymentName === 'dme-hermes' && typeof deploymentUid === 'string'
      ? replicaSets.filter((replicaSet) =>
          ownedBy(replicaSet, 'Deployment', deploymentName, deploymentUid) &&
            typeof replicaSet?.metadata?.uid === 'string').map((replicaSet) => replicaSet.metadata.uid)
      : [],
  )
  return pods.filter((pod) => {
    const owned = (pod?.metadata?.ownerReferences ?? []).some((owner) =>
      owner?.kind === 'ReplicaSet' && owner?.controller === true && ownedReplicaSets.has(owner?.uid))
    return owned || pod?.metadata?.labels?.['app.kubernetes.io/name'] === 'dme-hermes'
  })
}

export function dmeSourceRuntimeMatches(item, { legacy = false } = {}) {
  const spec = podSpecFor(item)
  if (!spec) return false
  const application = legacy
    ? ['hermes', 'mupot-subscriber', 'telegram-gateway']
    : ['hermes', 'telegram-gateway']
  const init = spec.initContainers ?? []
  const initAllowed = init.length === 0 || (init.length === 1 && approvedSeedProfile(init[0]))
  return exactNames(spec.containers, application) && initAllowed &&
    (spec.ephemeralContainers ?? []).length === 0
}
