// Lightweight cron expression parser for task scheduling.
//
// Supports two formats:
// 1. Time-of-day: "09:00", "17:30", "9:00 Mon-Fri"
// 2. Cron expressions (5 fields): "0 9 * * MON-FRI"
//
// Fields: minute hour day-of-month month day-of-week
//
// Supported syntax per field:
// - Literal: "5", "MON"
// - Wildcard: "*"
// - Range: "1-5", "MON-FRI"
// - List: "1,3,5"
// - Step: star-slash-15, 1-30/5

const DAY_NAMES: Record<string, number> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
}

const MONTH_NAMES: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
}

export interface CronSchedule {
  minutes: Set<number>
  hours: Set<number>
  daysOfMonth: Set<number>
  months: Set<number>
  daysOfWeek: Set<number>
}

/** Parse a time-of-day string like "09:00" or "17:30 Mon-Fri" */
export function parseTimeOfDay(input: string): CronSchedule | undefined {
  const trimmed = input.trim()

  // Match "HH:MM" or "H:MM" optionally followed by day range
  const match = trimmed.match(/^(\d{1,2}):(\d{2})(?:\s+(.+))?$/)
  if (!match) return undefined

  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined

  let daysOfWeek = allValues(0, 6)

  if (match[3]) {
    const parsed = parseField(match[3].toUpperCase(), 0, 6, DAY_NAMES)
    if (!parsed) return undefined
    daysOfWeek = parsed
  }

  return {
    minutes: new Set([minute]),
    hours: new Set([hour]),
    daysOfMonth: allValues(1, 31),
    months: allValues(1, 12),
    daysOfWeek,
  }
}

/** Parse a 5-field cron expression */
export function parseCron(input: string): CronSchedule | undefined {
  const parts = input.trim().split(/\s+/)
  if (parts.length !== 5) return undefined

  const minutes = parseField(parts[0] ?? '', 0, 59, {})
  const hours = parseField(parts[1] ?? '', 0, 23, {})
  const daysOfMonth = parseField(parts[2] ?? '', 1, 31, {})
  const months = parseField(parts[3] ?? '', 1, 12, MONTH_NAMES)
  const daysOfWeek = parseField(parts[4] ?? '', 0, 6, DAY_NAMES)

  if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeek) return undefined

  return { minutes, hours, daysOfMonth, months, daysOfWeek }
}

/** Try parsing as time-of-day first, then as cron expression */
export function parseScheduleExpression(input: string): CronSchedule | undefined {
  return parseTimeOfDay(input) ?? parseCron(input)
}

/** Calculate the next time this schedule fires after `after` */
export function nextOccurrence(schedule: CronSchedule, after: Date): Date {
  const next = new Date(after.getTime())
  next.setSeconds(0, 0)
  next.setMinutes(next.getMinutes() + 1)

  // Search up to 366 days ahead to handle yearly schedules
  const limit = after.getTime() + 366 * 24 * 60 * 60 * 1000

  while (next.getTime() < limit) {
    if (
      schedule.months.has(next.getMonth() + 1) &&
      schedule.daysOfMonth.has(next.getDate()) &&
      schedule.daysOfWeek.has(next.getDay()) &&
      schedule.hours.has(next.getHours()) &&
      schedule.minutes.has(next.getMinutes())
    ) {
      return next
    }

    // Advance: try to skip large chunks when possible
    if (!schedule.months.has(next.getMonth() + 1)) {
      next.setMonth(next.getMonth() + 1, 1)
      next.setHours(0, 0, 0, 0)
    } else if (
      !schedule.daysOfMonth.has(next.getDate()) ||
      !schedule.daysOfWeek.has(next.getDay())
    ) {
      next.setDate(next.getDate() + 1)
      next.setHours(0, 0, 0, 0)
    } else if (!schedule.hours.has(next.getHours())) {
      next.setHours(next.getHours() + 1, 0, 0, 0)
    } else {
      next.setMinutes(next.getMinutes() + 1)
    }
  }

  // Fallback: shouldn't happen for valid schedules, but return far-future to avoid infinite loops
  return new Date(limit)
}

/** Format a CronSchedule back to a human-readable string */
export function formatSchedule(schedule: CronSchedule): string {
  // Check if it's a simple daily time
  if (schedule.minutes.size === 1 && schedule.hours.size === 1) {
    const minute = [...schedule.minutes][0] ?? 0
    const hour = [...schedule.hours][0] ?? 0
    const time = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`

    if (schedule.daysOfWeek.size === 7) return `daily at ${time}`
    if (
      schedule.daysOfWeek.size === 5 &&
      !schedule.daysOfWeek.has(0) &&
      !schedule.daysOfWeek.has(6)
    ) {
      return `weekdays at ${time}`
    }

    const dayNames = [...schedule.daysOfWeek]
      .sort()
      .map((d) => Object.entries(DAY_NAMES).find(([_, v]) => v === d)?.[0] ?? String(d))
    return `${time} on ${dayNames.join(', ')}`
  }

  return 'custom cron schedule'
}

// --- Internal helpers ---

function allValues(min: number, max: number): Set<number> {
  const s = new Set<number>()
  for (let i = min; i <= max; i++) s.add(i)
  return s
}

function parseField(
  field: string,
  min: number,
  max: number,
  names: Record<string, number>,
): Set<number> | undefined {
  const result = new Set<number>()

  for (const part of field.split(',')) {
    const values = parsePart(part.trim(), min, max, names)
    if (!values) return undefined
    for (const v of values) result.add(v)
  }

  return result.size > 0 ? result : undefined
}

function parsePart(
  part: string,
  min: number,
  max: number,
  names: Record<string, number>,
): Set<number> | undefined {
  const result = new Set<number>()

  // Step: */N or range/N
  const stepMatch = part.match(/^(.+)\/(\d+)$/)
  const step = stepMatch ? Number(stepMatch[2]) : 1
  const base = stepMatch ? (stepMatch[1] ?? part) : part

  if (step < 1) return undefined

  // Wildcard
  if (base === '*') {
    for (let i = min; i <= max; i += step) result.add(i)
    return result
  }

  // Range: A-B
  const rangeMatch = base.match(/^([A-Z0-9]+)-([A-Z0-9]+)$/i)
  if (rangeMatch) {
    const start = resolveValue(rangeMatch[1] ?? '', names)
    const end = resolveValue(rangeMatch[2] ?? '', names)
    if (start === undefined || end === undefined) return undefined
    if (start < min || end > max) return undefined
    for (let i = start; i <= end; i += step) result.add(i)
    return result
  }

  // Single value
  const val = resolveValue(base, names)
  if (val === undefined || val < min || val > max) return undefined
  result.add(val)
  return result
}

function resolveValue(token: string, names: Record<string, number>): number | undefined {
  const upper = token.toUpperCase()
  if (upper in names) return names[upper]
  const num = Number(token)
  if (Number.isNaN(num)) return undefined
  return num
}
