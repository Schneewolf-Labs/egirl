import { log } from '../util/logger'
import type { Tool, ToolDefinition } from './types'

/**
 * Normalize a name by lowercasing and stripping separators (underscores, hyphens).
 * "read_file", "readFile", "Read-File" all become "readfile".
 */
function normalize(name: string): string {
  return name.toLowerCase().replace(/[_-]/g, '')
}

/**
 * Levenshtein edit distance between two strings.
 * Returns the minimum number of single-character edits (insert, delete, substitute).
 */
export function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length

  // Optimize for common cases
  if (m === 0) return n
  if (n === 0) return m
  if (a === b) return 0

  // Single-row DP
  const row = Array.from({ length: n + 1 }, (_, i) => i)

  for (let i = 1; i <= m; i++) {
    let prev = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const next = Math.min(
        row[j] + 1, // deletion
        prev + 1, // insertion
        row[j - 1] + cost, // substitution
      )
      row[j - 1] = prev
      prev = next
    }
    row[n] = prev
  }

  return row[n]
}

interface FuzzyMatch<T> {
  item: T
  name: string
  distance: number
  method: 'exact' | 'normalized' | 'distance'
}

/**
 * Maximum edit distance allowed for a fuzzy match, scaled by name length.
 * Short names (≤5 chars) allow 1 edit, longer names allow 2.
 */
function maxDistance(name: string): number {
  return name.length <= 5 ? 1 : 2
}

/**
 * Resolve a tool name against the registry using layered matching:
 * 1. Exact match (already handled by Map.get, but included for completeness)
 * 2. Normalized match (lowercase, strip separators)
 * 3. Edit distance match (Levenshtein ≤ threshold)
 *
 * Returns undefined if no match found or if the match is ambiguous.
 */
export function resolveToolName(
  name: string,
  tools: Map<string, Tool>,
): { tool: Tool; resolvedName: string; method: 'exact' | 'normalized' | 'distance' } | undefined {
  // Layer 1: Exact match
  const exact = tools.get(name)
  if (exact) {
    return { tool: exact, resolvedName: name, method: 'exact' }
  }

  const inputNorm = normalize(name)
  const candidates: FuzzyMatch<Tool>[] = []

  // Layer 2: Normalized match
  for (const [registeredName, tool] of tools) {
    if (normalize(registeredName) === inputNorm) {
      candidates.push({ item: tool, name: registeredName, distance: 0, method: 'normalized' })
    }
  }

  if (candidates.length === 1) {
    const match = candidates[0]
    log.warn(
      'tools',
      `Fuzzy matched tool "${name}" → "${match.name}" (normalized)`,
    )
    return { tool: match.item, resolvedName: match.name, method: 'normalized' }
  }

  // Layer 3: Edit distance (only if normalization didn't find a unique match)
  if (candidates.length === 0) {
    const threshold = maxDistance(name)

    for (const [registeredName, tool] of tools) {
      const dist = levenshtein(inputNorm, normalize(registeredName))
      if (dist > 0 && dist <= threshold) {
        candidates.push({ item: tool, name: registeredName, distance: dist, method: 'distance' })
      }
    }

    // Only accept if there's a single best match
    if (candidates.length > 0) {
      candidates.sort((a, b) => a.distance - b.distance)
      const best = candidates[0]

      // Ambiguous if multiple candidates share the same best distance
      if (candidates.length > 1 && candidates[1].distance === best.distance) {
        log.warn(
          'tools',
          `Ambiguous fuzzy match for "${name}": ${candidates.map((c) => `"${c.name}"(d=${c.distance})`).join(', ')}`,
        )
        return undefined
      }

      log.warn(
        'tools',
        `Fuzzy matched tool "${name}" → "${best.name}" (edit distance ${best.distance})`,
      )
      return { tool: best.item, resolvedName: best.name, method: 'distance' }
    }
  }

  return undefined
}

/**
 * Remap parameter keys from hallucinated names to the tool's actual parameter names.
 * Uses the same normalize-then-distance approach.
 */
export function remapParams(
  definition: ToolDefinition,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const schema = definition.parameters as {
    properties?: Record<string, unknown>
  }
  if (!schema.properties) return args

  const expectedKeys = Object.keys(schema.properties)
  if (expectedKeys.length === 0) return args

  // Build normalized lookup
  const normMap = new Map<string, string>()
  for (const key of expectedKeys) {
    normMap.set(normalize(key), key)
  }

  const remapped: Record<string, unknown> = {}
  let didRemap = false

  for (const [inputKey, value] of Object.entries(args)) {
    // Exact match — pass through
    if (inputKey in schema.properties) {
      remapped[inputKey] = value
      continue
    }

    // Normalized match
    const normKey = normalize(inputKey)
    const normalizedMatch = normMap.get(normKey)
    if (normalizedMatch) {
      log.warn('tools', `Remapped param "${inputKey}" → "${normalizedMatch}" for ${definition.name}`)
      remapped[normalizedMatch] = value
      didRemap = true
      continue
    }

    // Edit distance match
    let bestKey: string | undefined
    let bestDist = Number.POSITIVE_INFINITY
    let isAmbiguous = false

    for (const expected of expectedKeys) {
      const dist = levenshtein(normKey, normalize(expected))
      if (dist < bestDist) {
        bestDist = dist
        bestKey = expected
        isAmbiguous = false
      } else if (dist === bestDist) {
        isAmbiguous = true
      }
    }

    const threshold = maxDistance(inputKey)
    if (bestKey && bestDist <= threshold && !isAmbiguous) {
      log.warn(
        'tools',
        `Remapped param "${inputKey}" → "${bestKey}" for ${definition.name} (edit distance ${bestDist})`,
      )
      remapped[bestKey] = value
      didRemap = true
      continue
    }

    // No match — pass through as-is (tool will ignore unknown params)
    remapped[inputKey] = value
  }

  if (didRemap) {
    log.debug('tools', `Param remapping for ${definition.name}:`, {
      original: Object.keys(args),
      remapped: Object.keys(remapped),
    })
  }

  return remapped
}
