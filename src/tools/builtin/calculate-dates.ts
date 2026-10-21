/**
 * Date arithmetic for the calculate tool. Kept apart from the numeric parser because dates take
 * and return strings (an ISO date, a weekday name), which the number-only grammar in
 * calculate-parser.ts has no values for. A statement that begins with one of these function
 * names is routed here instead; everything else stays arithmetic.
 *
 * All math is in UTC so a day count never drifts by a timezone hour. "today" is accepted anywhere
 * a date is, so relative questions ("90 days from today", "days until Christmas") work without the
 * model having to know or type the current date.
 */

import { CalcError } from './calculate-parser'

export const DATE_FUNCTIONS = new Set(['days_between', 'add_days', 'weekday', 'today'])

const DAY = 86_400_000
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/

/** Statements this module owns: `name(` where name is a date function. */
export function isDateStatement(src: string): boolean {
  const m = /^\s*([A-Za-z_]\w*)\s*\(/.exec(src)
  return m !== null && DATE_FUNCTIONS.has(m[1] as string)
}

/** Parse an ISO date (or "today") to a UTC midnight epoch-millisecond value. */
function parseDate(arg: string): number {
  const s = arg.trim()
  if (s === 'today' || s === '"today"' || s === "'today'") {
    const now = new Date()
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  }
  const unquoted = s.replace(/^["']|["']$/g, '')
  const m = ISO.exec(unquoted)
  if (!m) throw new CalcError(`'${unquoted}' is not a date — use YYYY-MM-DD (or today)`)
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const t = Date.UTC(y, mo - 1, d)
  const back = new Date(t)
  // Date.UTC rolls overflow over (month 13 -> next year); reject it so a typo is not silently a
  // different day.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    throw new CalcError(`'${unquoted}' is not a real calendar date`)
  }
  return t
}

function format(t: number): string {
  const d = new Date(t)
  const iso = d.toISOString().slice(0, 10)
  return `${iso} (${WEEKDAYS[d.getUTCDay()]})`
}

/** Split the args of a single top-level call. No nesting: date functions do not take each other. */
function splitArgs(inner: string): string[] {
  if (inner.trim() === '') return []
  if (inner.includes('(')) throw new CalcError('date functions do not take nested calls')
  return inner.split(',').map((a) => a.trim())
}

export function evaluateDateStatement(src: string): string {
  const m = /^\s*([A-Za-z_]\w*)\s*\((.*)\)\s*$/.exec(src.trim())
  if (!m) throw new CalcError('malformed date expression')
  const name = m[1] as string
  const args = splitArgs(m[2] as string)
  const argc = (lo: number, hi = lo): void => {
    if (args.length < lo || args.length > hi) {
      throw new CalcError(
        `${name}() takes ${lo === hi ? lo : `${lo} to ${hi}`} argument(s), got ${args.length}`,
      )
    }
  }
  switch (name) {
    case 'today': {
      argc(0)
      return `today is ${format(parseDate('today'))}`
    }
    case 'weekday': {
      argc(1)
      const d = new Date(parseDate(args[0] as string))
      return `${WEEKDAYS[d.getUTCDay()]}`
    }
    case 'days_between': {
      argc(2)
      const a = parseDate(args[0] as string)
      const b = parseDate(args[1] as string)
      return `${Math.round((b - a) / DAY)}`
    }
    case 'add_days': {
      argc(2)
      const base = parseDate(args[0] as string)
      const n = Number((args[1] as string).trim())
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        throw new CalcError(`add_days() needs a whole number of days, got '${args[1]}'`)
      }
      return format(base + n * DAY)
    }
    default:
      throw new CalcError(`unknown date function '${name}'`)
  }
}
