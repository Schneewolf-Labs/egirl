import { describe, test, expect } from 'bun:test'
import {
  parseCron,
  parseTimeOfDay,
  parseScheduleExpression,
  nextOccurrence,
  formatSchedule,
} from '../../src/tasks/cron'

describe('parseTimeOfDay', () => {
  test('parses simple time', () => {
    const result = parseTimeOfDay('09:00')
    expect(result).toBeDefined()
    expect(result!.hours).toEqual(new Set([9]))
    expect(result!.minutes).toEqual(new Set([0]))
    expect(result!.daysOfWeek.size).toBe(7)
  })

  test('parses time with day range', () => {
    const result = parseTimeOfDay('09:00 Mon-Fri')
    expect(result).toBeDefined()
    expect(result!.hours).toEqual(new Set([9]))
    expect(result!.daysOfWeek).toEqual(new Set([1, 2, 3, 4, 5]))
  })

  test('parses single-digit hour', () => {
    const result = parseTimeOfDay('9:30')
    expect(result).toBeDefined()
    expect(result!.hours).toEqual(new Set([9]))
    expect(result!.minutes).toEqual(new Set([30]))
  })

  test('rejects invalid hour', () => {
    expect(parseTimeOfDay('25:00')).toBeUndefined()
  })

  test('rejects invalid minute', () => {
    expect(parseTimeOfDay('09:60')).toBeUndefined()
  })

  test('rejects garbage', () => {
    expect(parseTimeOfDay('not a time')).toBeUndefined()
  })
})

describe('parseCron', () => {
  test('parses every-15-minutes', () => {
    const result = parseCron('*/15 * * * *')
    expect(result).toBeDefined()
    expect(result!.minutes).toEqual(new Set([0, 15, 30, 45]))
    expect(result!.hours.size).toBe(24)
  })

  test('parses weekdays at 9am', () => {
    const result = parseCron('0 9 * * MON-FRI')
    expect(result).toBeDefined()
    expect(result!.minutes).toEqual(new Set([0]))
    expect(result!.hours).toEqual(new Set([9]))
    expect(result!.daysOfWeek).toEqual(new Set([1, 2, 3, 4, 5]))
  })

  test('parses list of hours', () => {
    const result = parseCron('0 9,12,17 * * *')
    expect(result).toBeDefined()
    expect(result!.hours).toEqual(new Set([9, 12, 17]))
  })

  test('parses specific day of month', () => {
    const result = parseCron('0 0 1 * *')
    expect(result).toBeDefined()
    expect(result!.daysOfMonth).toEqual(new Set([1]))
  })

  test('parses month names', () => {
    const result = parseCron('0 0 1 JAN,JUL *')
    expect(result).toBeDefined()
    expect(result!.months).toEqual(new Set([1, 7]))
  })

  test('parses step with range', () => {
    const result = parseCron('0-30/10 * * * *')
    expect(result).toBeDefined()
    expect(result!.minutes).toEqual(new Set([0, 10, 20, 30]))
  })

  test('rejects too few fields', () => {
    expect(parseCron('* * *')).toBeUndefined()
  })

  test('rejects too many fields', () => {
    expect(parseCron('* * * * * *')).toBeUndefined()
  })

  test('rejects out-of-range values', () => {
    expect(parseCron('60 * * * *')).toBeUndefined()
    expect(parseCron('* 25 * * *')).toBeUndefined()
    expect(parseCron('* * 32 * *')).toBeUndefined()
    expect(parseCron('* * * 13 *')).toBeUndefined()
    expect(parseCron('* * * * 7')).toBeUndefined()
  })
})

describe('parseScheduleExpression', () => {
  test('tries time-of-day first, then cron', () => {
    // Time-of-day
    const time = parseScheduleExpression('09:00')
    expect(time).toBeDefined()
    expect(time!.hours).toEqual(new Set([9]))

    // Cron
    const cron = parseScheduleExpression('*/15 * * * *')
    expect(cron).toBeDefined()
    expect(cron!.minutes).toEqual(new Set([0, 15, 30, 45]))
  })

  test('returns undefined for garbage', () => {
    expect(parseScheduleExpression('lol nope')).toBeUndefined()
  })
})

describe('nextOccurrence', () => {
  test('finds next minute for every-minute schedule', () => {
    const schedule = parseCron('* * * * *')!
    const after = new Date('2025-06-15T10:30:00')
    const next = nextOccurrence(schedule, after)
    expect(next.getTime()).toBe(new Date('2025-06-15T10:31:00').getTime())
  })

  test('finds next weekday morning', () => {
    const schedule = parseCron('0 9 * * MON-FRI')!
    // Saturday at noon
    const after = new Date('2025-06-14T12:00:00')
    const next = nextOccurrence(schedule, after)
    // Should be Monday at 9am
    expect(next.getDay()).toBe(1) // Monday
    expect(next.getHours()).toBe(9)
    expect(next.getMinutes()).toBe(0)
  })

  test('finds next occurrence on same day if not yet passed', () => {
    const schedule = parseTimeOfDay('17:00')!
    const after = new Date('2025-06-15T10:00:00')
    const next = nextOccurrence(schedule, after)
    expect(next.getDate()).toBe(15)
    expect(next.getHours()).toBe(17)
  })

  test('finds next occurrence on next day if already passed', () => {
    const schedule = parseTimeOfDay('09:00')!
    const after = new Date('2025-06-15T10:00:00')
    const next = nextOccurrence(schedule, after)
    expect(next.getDate()).toBe(16)
    expect(next.getHours()).toBe(9)
  })
})

describe('formatSchedule', () => {
  test('formats daily schedule', () => {
    const schedule = parseTimeOfDay('09:00')!
    expect(formatSchedule(schedule)).toBe('daily at 09:00')
  })

  test('formats weekday schedule', () => {
    const schedule = parseTimeOfDay('09:00 Mon-Fri')!
    expect(formatSchedule(schedule)).toBe('weekdays at 09:00')
  })

  test('formats complex schedule as custom', () => {
    const schedule = parseCron('*/15 * * * *')!
    expect(formatSchedule(schedule)).toBe('custom cron schedule')
  })
})
