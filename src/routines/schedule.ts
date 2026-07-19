import { parseCronExpression } from 'cron-schedule'
import type { Cron } from 'cron-schedule'
import type { RoutineSchedule } from './types'

export type ScheduleValidationError =
  | 'invalid_timezone' | 'invalid_trigger_fields' | 'invalid_once_at' | 'invalid_cron_expression'

export type ScheduleValidationResult =
  | { ok: true }
  | { ok: false; error: ScheduleValidationError }

interface WallMinute {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function formatter(timezone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timezone)
  if (cached) return cached
  const created = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  })
  formatterCache.set(timezone, created)
  return created
}

function validTimezone(timezone: string): boolean {
  if (timezone.length < 1 || timezone.length > 100) return false
  try {
    formatter(timezone).format(new Date(0))
    return true
  } catch {
    return false
  }
}

function validInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
}

function cronFor(expression: unknown): Cron | null {
  if (typeof expression !== 'string') return null
  if (expression.trim() !== expression || expression.startsWith('@')) return null
  if (expression.split(/\s+/).length !== 5) return null
  try {
    return parseCronExpression(expression)
  } catch {
    return null
  }
}

export function validateRoutineSchedule(schedule: RoutineSchedule): ScheduleValidationResult {
  if (!validTimezone(schedule.timezone)) return { ok: false, error: 'invalid_timezone' }
  if (schedule.kind === 'manual') {
    if (schedule.runOnceAt !== undefined || schedule.cronExpression !== undefined) {
      return { ok: false, error: 'invalid_trigger_fields' }
    }
    return { ok: true }
  }
  if (schedule.kind === 'once') {
    if (schedule.cronExpression !== undefined) return { ok: false, error: 'invalid_trigger_fields' }
    return validInstant(schedule.runOnceAt)
      ? { ok: true }
      : { ok: false, error: 'invalid_once_at' }
  }
  if (schedule.runOnceAt !== undefined) return { ok: false, error: 'invalid_trigger_fields' }
  return cronFor(schedule.cronExpression)
    ? { ok: true }
    : { ok: false, error: 'invalid_cron_expression' }
}

function wallMinute(instant: Date, timezone: string): WallMinute {
  const values: Record<string, number> = {}
  for (const part of formatter(timezone).formatToParts(instant)) {
    if (part.type !== 'literal') values[part.type] = Number(part.value)
  }
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
  }
}

function wallStamp(wall: WallMinute): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute)
}

function wallFromStamp(stamp: number): WallMinute {
  const date = new Date(stamp)
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
  }
}

function dayMatches(cron: Cron, wall: WallMinute): boolean {
  if (!cron.months.includes(wall.month - 1)) return false
  const weekday = new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay()
  const dayRestricted = cron.days.length !== 31
  const weekdayRestricted = cron.weekdays.length !== 7
  if (dayRestricted && weekdayRestricted) {
    return cron.days.includes(wall.day) || cron.weekdays.includes(weekday)
  }
  return cron.days.includes(wall.day) && cron.weekdays.includes(weekday)
}

function nextWallCandidate(cron: Cron, after: WallMinute): WallMinute | null {
  const afterStamp = wallStamp(after)
  const firstDay = Date.UTC(after.year, after.month - 1, after.day)
  for (let dayOffset = 0; dayOffset <= 366 * 5; dayOffset++) {
    const day = wallFromStamp(firstDay + dayOffset * 86_400_000)
    if (!dayMatches(cron, day)) continue
    for (const hour of cron.hours) {
      for (const minute of cron.minutes) {
        const candidate = { ...day, hour, minute }
        if (wallStamp(candidate) > afterStamp) return candidate
      }
    }
  }
  return null
}

function sameWall(left: WallMinute, right: WallMinute): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day
    && left.hour === right.hour && left.minute === right.minute
}

function firstInstantForWall(wall: WallMinute, timezone: string): Date | null {
  const center = wallStamp(wall)
  const offsets = new Set<number>()
  for (const hours of [-36, -12, 0, 12, 36]) {
    const probe = new Date(center + hours * 3_600_000)
    const probeMinute = Math.floor(probe.getTime() / 60_000) * 60_000
    offsets.add(wallStamp(wallMinute(probe, timezone)) - probeMinute)
  }
  const candidates = [...offsets]
    .map(offset => new Date(center - offset))
    .filter(candidate => sameWall(wallMinute(candidate, timezone), wall))
    .sort((left, right) => left.getTime() - right.getTime())
  return candidates[0] ?? null
}

export function nextRoutineOccurrence(schedule: RoutineSchedule, after: Date): Date | null {
  if (!Number.isFinite(after.getTime())) return null
  if (schedule.kind === 'manual') return null
  if (schedule.kind === 'once') {
    const instant = new Date(schedule.runOnceAt)
    return Number.isFinite(instant.getTime()) && instant.getTime() > after.getTime() ? instant : null
  }
  const cron = cronFor(schedule.cronExpression)
  if (!cron || !validTimezone(schedule.timezone)) return null

  let cursor = wallMinute(after, schedule.timezone)
  for (let attempts = 0; attempts < 366 * 5 * 24 * 60; attempts++) {
    const wall = nextWallCandidate(cron, cursor)
    if (!wall) return null
    const instant = firstInstantForWall(wall, schedule.timezone)
    if (instant && instant.getTime() > after.getTime()) return instant
    cursor = wall
  }
  return null
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

export function routineOccurrenceKey(
  schedule: RoutineSchedule,
  scheduledFor: Date,
  manualKey?: string,
): string {
  if (schedule.kind === 'manual') {
    if (!manualKey || !/^[A-Za-z0-9_.:-]{1,200}$/.test(manualKey)) {
      throw new Error('invalid_manual_occurrence_key')
    }
    return `manual:${manualKey}`
  }
  if (schedule.kind === 'once') return `once:${scheduledFor.toISOString()}`
  const wall = wallMinute(scheduledFor, schedule.timezone)
  return `cron:${wall.year}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}:00[${schedule.timezone}]`
}
