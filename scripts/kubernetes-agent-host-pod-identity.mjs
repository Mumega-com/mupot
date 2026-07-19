function ownedBy(item, kind, name, uid) {
  return (item?.metadata?.ownerReferences ?? []).some((owner) =>
    owner?.kind === kind && owner?.name === name && owner?.uid === uid && owner?.controller === true)
}

function podContainers(pod) {
  return [...(pod?.spec?.initContainers ?? []), ...(pod?.spec?.containers ?? []), ...(pod?.spec?.ephemeralContainers ?? [])]
}

export function agentHostPods({ deployment, replicaSets = [], pods = [] }) {
  const deploymentName = deployment?.metadata?.name
  const deploymentUid = deployment?.metadata?.uid
  const ownedReplicaSets = new Set(
    deploymentName === 'dme-hermes-agent-host' && typeof deploymentUid === 'string'
      ? replicaSets.filter((replicaSet) =>
          ownedBy(replicaSet, 'Deployment', deploymentName, deploymentUid) &&
            typeof replicaSet?.metadata?.uid === 'string').map((replicaSet) => replicaSet.metadata.uid)
      : [],
  )
  return pods.filter((pod) => {
    const labels = pod?.metadata?.labels ?? {}
    const owned = (pod?.metadata?.ownerReferences ?? []).some((owner) =>
      owner?.kind === 'ReplicaSet' && owner?.controller === true && ownedReplicaSets.has(owner?.uid))
    return owned || labels['app.kubernetes.io/name'] === 'mupot-agent-host' ||
      podContainers(pod).some((container) => container?.name === 'agent-host')
  })
}
