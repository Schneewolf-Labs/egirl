const UNITS: Record<string, number> = {
  s: 1000,
  sec: 1000,
  second: 1000,
  seconds: 1000,
  m: 60 * 1000,
  min: 60 * 1000,
  minute: 60 * 1000,
  minutes: 60 * 1000,
  h: 60 * 60 * 1000,
  hr: 60 * 60 * 1000,
  hour: 60 * 60 * 1000,
  hours: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
}

/**
 * Parse a human-readable interval string into milliseconds.
 * Supports: "30s", "5m", "2h", "1d", "1.5h", "90min", etc.
 * Returns undefined if the string can't be parsed.
 */
export function parseInterval(input: string): number | undefined {
  const trimmed = input.trim().toLowerCase()
  if (!trimmed) return undefined

  // Try plain number (treated as minutes for convenience)
  const plainNum = Number(trimmed)
  if (!Number.isNaN(plainNum) && plainNum > 0) {
    return plainNum * 60 * 1000
  }

  // Match "number + unit"
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*([a-z]+)$/)
  if (!match) return undefined

  const value = Number(match[1])
  const unit = match[2] ?? ''

  if (Number.isNaN(value) || value <= 0) return undefined

  const multiplier = UNITS[unit]
  if (!multiplier) return undefined

  return Math.round(value * multiplier)
}

/**
 * Format milliseconds into a human-readable interval.
 */
export function formatInterval(ms: number): string {
  if (ms < 60 * 1000) return `${Math.round(ms / 1000)}s`
  if (ms < 60 * 60 * 1000) return `${Math.round(ms / (60 * 1000))}m`
  if (ms < 24 * 60 * 60 * 1000) return `${Math.round(ms / (60 * 60 * 1000))}h`
  return `${Math.round(ms / (24 * 60 * 60 * 1000))}d`
}
