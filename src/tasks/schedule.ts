/**
 * Unified schedule resolver.
 * Handles both interval-based and cron-based schedules, with business hours support.
 */

import { parseScheduleExpression, nextOccurrence, type CronSchedule } from './cron'

export interface BusinessHours {
  start: number  // hour (0-23)
  end: number    // hour (0-23)
  days: number[] // days of week (0=Sun, 6=Sat)
}

const DEFAULT_BUSINESS_HOURS: BusinessHours = {
  start: 9,
  end: 17,
  days: [1, 2, 3, 4, 5], // Mon-Fri
}

/**
 * Parse a business hours string like "9-17 Mon-Fri" or "8-22".
 * Returns undefined if parsing fails.
 */
export function parseBusinessHours(input: string): BusinessHours | undefined {
  const trimmed = input.trim()
  if (!trimmed) return undefined

  // Match "H-H" or "HH-HH" optionally followed by day spec
  const match = trimmed.match(/^(\d{1,2})-(\d{1,2})(?:\s+(.+))?$/i)
  if (!match) {
    if (trimmed.toLowerCase() === 'business') return DEFAULT_BUSINESS_HOURS
    return undefined
  }

  const start = Number(match[1])
  const end = Number(match[2])
  if (start < 0 || start > 23 || end < 0 || end > 23) return undefined

  let days = DEFAULT_BUSINESS_HOURS.days
  if (match[3]) {
    days = parseDaySpec(match[3])
    if (days.length === 0) return undefined
  }

  return { start, end, days }
}

/**
 * Check if a given time falls within business hours.
 */
export function isWithinBusinessHours(date: Date, hours: BusinessHours): boolean {
  const day = date.getDay()
  if (!hours.days.includes(day)) return false

  const hour = date.getHours()
  if (hours.start <= hours.end) {
    // Normal range: 9-17
    return hour >= hours.start && hour < hours.end
  }
  // Overnight range: 22-6 means 22-23 or 0-5
  return hour >= hours.start || hour < hours.end
}

/**
 * Find the next time that falls within business hours at or after `date`.
 */
export function nextBusinessHoursStart(date: Date, hours: BusinessHours): Date {
  const next = new Date(date.getTime())
  // Try up to 8 days ahead
  for (let attempt = 0; attempt < 8 * 24; attempt++) {
    if (isWithinBusinessHours(next, hours)) return next

    // If wrong day, skip to next day at start hour
    if (!hours.days.includes(next.getDay())) {
      next.setDate(next.getDate() + 1)
      next.setHours(hours.start, 0, 0, 0)
    } else if (next.getHours() < hours.start) {
      // Before start: jump to start
      next.setHours(hours.start, 0, 0, 0)
    } else {
      // After end: jump to next valid day
      next.setDate(next.getDate() + 1)
      next.setHours(hours.start, 0, 0, 0)
    }
  }
  return next
}

/**
 * Calculate the next run time for a task, considering schedule type and business hours.
 */
export function calculateNextRun(params: {
  intervalMs?: number
  cronSchedule?: CronSchedule
  businessHours?: BusinessHours
  now?: Date
}): number {
  const now = params.now ?? new Date()

  let nextTime: Date

  if (params.cronSchedule) {
    nextTime = nextOccurrence(params.cronSchedule, now)
  } else if (params.intervalMs) {
    nextTime = new Date(now.getTime() + params.intervalMs)
  } else {
    return now.getTime()
  }

  // Apply business hours constraint
  if (params.businessHours) {
    if (!isWithinBusinessHours(nextTime, params.businessHours)) {
      nextTime = nextBusinessHoursStart(nextTime, params.businessHours)
    }
  }

  return nextTime.getTime()
}

// --- Internal helpers ---

const DAY_MAP: Record<string, number> = {
  SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
  SUNDAY: 0, MONDAY: 1, TUESDAY: 2, WEDNESDAY: 3, THURSDAY: 4, FRIDAY: 5, SATURDAY: 6,
}

function parseDaySpec(spec: string): number[] {
  const upper = spec.toUpperCase().trim()

  // Range: "Mon-Fri"
  const rangeMatch = upper.match(/^([A-Z]+)-([A-Z]+)$/)
  if (rangeMatch) {
    const start = DAY_MAP[rangeMatch[1]!]
    const end = DAY_MAP[rangeMatch[2]!]
    if (start === undefined || end === undefined) return []
    const result: number[] = []
    for (let i = start; i !== (end + 1) % 7; i = (i + 1) % 7) {
      result.push(i)
    }
    result.push(end)
    // Deduplicate in case start === end
    return [...new Set(result)]
  }

  // List: "Mon,Wed,Fri"
  const days: number[] = []
  for (const part of upper.split(',')) {
    const d = DAY_MAP[part.trim()]
    if (d === undefined) return []
    days.push(d)
  }
  return days
}
