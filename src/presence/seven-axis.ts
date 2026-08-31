// src/presence/seven-axis.ts — seat identity axes for check_in.
//
// Distinct seats on the same member token persist independently. River's
// Cursor Cloud seat is `river-cursor`.

import { RIVER_CURSOR_SEAT } from '../agents/river-lead'

export const SEVEN_AXIS_KEYS = [
  'seat',
  'harness',
  'machine',
  'model',
  'provider',
  'effort',
  'flight_id',
] as const

export type SevenAxisKey = (typeof SEVEN_AXIS_KEYS)[number]

export const SEVEN_AXIS_HARNESSES = [
  'cursor-ide',
  'cursor-cloud',
  'antigravity-cli',
  'claude-code',
  'codex-cli',
  'prime',
  'hermes',
  'grok-cli',
  'unknown',
] as const

export type SevenAxisHarness = (typeof SEVEN_AXIS_HARNESSES)[number]

export const SEVEN_AXIS_EFFORTS = ['low', 'medium', 'high', 'extended-thinking-64k'] as const

export type SevenAxisEffort = (typeof SEVEN_AXIS_EFFORTS)[number]

export interface SevenAxisPresence {
  seat: string
  harness: SevenAxisHarness | null
  machine: string | null
  model: string | null
  provider: string | null
  effort: SevenAxisEffort | null
  flight_id: string | null
}

export function isRiverCursorSeat(seat: string | null | undefined): boolean {
  return (seat ?? '').trim() === RIVER_CURSOR_SEAT
}

function optionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, 120) : null
}

function optionalEnum<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return (allowed as readonly string[]).includes(trimmed) ? (trimmed as T) : null
}

export function parseSevenAxisCheckin(
  args: Record<string, unknown>,
  fallbackSeat = '',
): SevenAxisPresence {
  const seat = optionalString(args.seat) || optionalString(args.name) || optionalString(args.label) || fallbackSeat
  return {
    seat,
    harness: optionalEnum(args.harness, SEVEN_AXIS_HARNESSES),
    machine: optionalString(args.machine),
    model: optionalString(args.model),
    provider: optionalString(args.provider),
    effort: optionalEnum(args.effort, SEVEN_AXIS_EFFORTS),
    flight_id: optionalString(args.flight_id),
  }
}

export function sevenAxisHasValues(axes: SevenAxisPresence): boolean {
  return Boolean(
    axes.seat ||
      axes.harness ||
      axes.machine ||
      axes.model ||
      axes.provider ||
      axes.effort ||
      axes.flight_id,
  )
}
