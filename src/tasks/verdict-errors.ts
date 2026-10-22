// src/tasks/verdict-errors.ts — the verdict race error, in its own leaf module so verdict-binding.ts (imported BY
// src/tasks/service.ts) can subclass it without an import cycle. Re-exported from service.ts, where it has always lived.

export class VerdictRaceError extends Error {
  constructor(taskId: string) {
    super(`verdict_race: task ${taskId} is no longer in review (concurrent verdict won)`)
    this.name = 'VerdictRaceError'
  }
}
