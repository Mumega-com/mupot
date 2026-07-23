// Project-shared memory scope — the opaque key both project_remember/project_recall
// and the project docs surface use. One string → one engrams+Vectorize store.
// Docs = project memory = the mubot's context (no second docs table).

export function projectMemoryScope(projectId: string): string {
  return `project:${projectId}`
}
