import { describe, test, expect } from 'bun:test'
import {
  parseBusinessHours,
  isWithinBusinessHours,
  nextBusinessHoursStart,
  calculateNextRun,
} from '../../src/tasks/schedule'
import { parseScheduleExpression } from '../../src/tasks/cron'

describe('parseBusinessHours', () => {
  test('parses simple range', () => {
    const bh = parseBusinessHours('9-17')
    expect(bh).toBeDefined()
    expect(bh!.start).toBe(9)
    expect(bh!.end).toBe(17)
    expect(bh!.days).toEqual([1, 2, 3, 4, 5])
  })

  test('parses range with day spec', () => {
    const bh = parseBusinessHours('8-22 Mon-Sat')
    expect(bh).toBeDefined()
    expect(bh!.start).toBe(8)
    expect(bh!.end).toBe(22)
    expect(bh!.days).toEqual([1, 2, 3, 4, 5, 6])
  })

  test('parses "business" keyword', () => {
    const bh = parseBusinessHours('business')
    expect(bh).toBeDefined()
    expect(bh!.start).toBe(9)
    expect(bh!.end).toBe(17)
    expect(bh!.days).toEqual([1, 2, 3, 4, 5])
  })

  test('rejects invalid range', () => {
    expect(parseBusinessHours('25-30')).toBeUndefined()
  })

  test('rejects empty string', () => {
    expect(parseBusinessHours('')).toBeUndefined()
  })
})

describe('isWithinBusinessHours', () => {
  const bh = parseBusinessHours('9-17 Mon-Fri')!

  test('within hours on weekday', () => {
    // Wednesday at 10am
    expect(isWithinBusinessHours(new Date('2025-06-11T10:00:00'), bh)).toBe(true)
  })

  test('before hours on weekday', () => {
    // Wednesday at 8am
    expect(isWithinBusinessHours(new Date('2025-06-11T08:00:00'), bh)).toBe(false)
  })

  test('after hours on weekday', () => {
    // Wednesday at 6pm
    expect(isWithinBusinessHours(new Date('2025-06-11T18:00:00'), bh)).toBe(false)
  })

  test('weekend', () => {
    // Saturday at noon
    expect(isWithinBusinessHours(new Date('2025-06-14T12:00:00'), bh)).toBe(false)
  })

  test('at boundary: start hour is inclusive', () => {
    // Wednesday at exactly 9am
    expect(isWithinBusinessHours(new Date('2025-06-11T09:00:00'), bh)).toBe(true)
  })

  test('at boundary: end hour is exclusive', () => {
    // Wednesday at exactly 5pm
    expect(isWithinBusinessHours(new Date('2025-06-11T17:00:00'), bh)).toBe(false)
  })
})

describe('nextBusinessHoursStart', () => {
  const bh = parseBusinessHours('9-17 Mon-Fri')!

  test('already in business hours', () => {
    const date = new Date('2025-06-11T10:00:00') // Wed 10am
    const next = nextBusinessHoursStart(date, bh)
    expect(next.getTime()).toBe(date.getTime())
  })

  test('before business hours same day', () => {
    const date = new Date('2025-06-11T07:00:00') // Wed 7am
    const next = nextBusinessHoursStart(date, bh)
    expect(next.getHours()).toBe(9)
    expect(next.getDate()).toBe(11) // Same day
  })

  test('after business hours, jumps to next day', () => {
    const date = new Date('2025-06-11T18:00:00') // Wed 6pm
    const next = nextBusinessHoursStart(date, bh)
    expect(next.getHours()).toBe(9)
    expect(next.getDate()).toBe(12) // Thursday
  })

  test('Friday evening jumps to Monday', () => {
    const date = new Date('2025-06-13T18:00:00') // Fri 6pm
    const next = nextBusinessHoursStart(date, bh)
    expect(next.getHours()).toBe(9)
    expect(next.getDay()).toBe(1) // Monday
  })
})

describe('calculateNextRun', () => {
  test('interval-based', () => {
    const now = new Date('2025-06-11T10:00:00')
    const next = calculateNextRun({ intervalMs: 30 * 60 * 1000, now })
    expect(next).toBe(now.getTime() + 30 * 60 * 1000)
  })

  test('cron-based', () => {
    const now = new Date('2025-06-11T10:00:00') // Wed
    const schedule = parseScheduleExpression('0 9 * * MON-FRI')!
    const next = calculateNextRun({ cronSchedule: schedule, now })
    // Next 9am is Thursday
    const nextDate = new Date(next)
    expect(nextDate.getHours()).toBe(9)
    expect(nextDate.getMinutes()).toBe(0)
    expect(nextDate.getDate()).toBe(12)
  })

  test('interval with business hours delays outside hours', () => {
    // Wed at 4:50pm, 30min interval would land at 5:20pm (outside 9-17)
    const now = new Date('2025-06-11T16:50:00')
    const bh = parseBusinessHours('9-17 Mon-Fri')!
    const next = calculateNextRun({ intervalMs: 30 * 60 * 1000, businessHours: bh, now })
    const nextDate = new Date(next)
    // Should be pushed to Thursday 9am
    expect(nextDate.getHours()).toBe(9)
    expect(nextDate.getDate()).toBe(12)
  })
})
