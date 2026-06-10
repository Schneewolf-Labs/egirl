/**
 * Fuzzy matching for tool call names.
 *
 * Local models occasionally emit near-miss tool names: wrong casing
 * (`Read_File`), wrong separators (`read-file`), hallucinated namespaces
 * (`functions.read_file`), or small typos (`execute_comand`). Failing the
 * call burns a full LLM roundtrip on an error message, so resolve the name
 * to a registered tool when — and only when — the match is unambiguous.
 */

export interface ToolNameMatch {
  /** Registered tool name to execute, when a confident match exists */
  match?: string
  /** Closest registered names when no confident match exists */
  suggestions: string[]
}

/** Auto-match on edit distance only for names at least this long */
const MIN_AUTO_MATCH_LENGTH = 5
/** Max edit distance for an auto-match; one typo or adjacent transposition */
const MAX_AUTO_DISTANCE = 1
/** Max edit distance for a "did you mean" suggestion */
const MAX_SUGGESTION_DISTANCE = 3
const MAX_SUGGESTIONS = 3

/** Lowercase, convert camelCase boundaries and separator runs to `_` */
export function normalizeToolName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/** Candidate forms of a called name: normalized, plus the last namespace segment */
function candidateForms(name: string): string[] {
  const forms = [normalizeToolName(name)]
  const segments = name.split(/[./:]/)
  const last = segments.length > 1 ? normalizeToolName(segments[segments.length - 1] ?? '') : ''
  if (last && !forms.includes(last)) {
    forms.push(last)
  }
  return forms.filter((f) => f.length > 0)
}

/**
 * Optimal string alignment distance: Levenshtein where an adjacent
 * transposition (`commnad` → `command`) counts as a single edit.
 */
function osaDistance(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  let prevPrev: number[] = []
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j)

  for (let i = 1; i <= a.length; i++) {
    const curr: number[] = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1
      let value = Math.min(
        (curr[j - 1] ?? Infinity) + 1, // insertion
        (prev[j] ?? Infinity) + 1, // deletion
        (prev[j - 1] ?? Infinity) + cost, // substitution
      )
      if (
        i > 1 &&
        j > 1 &&
        a.charCodeAt(i - 1) === b.charCodeAt(j - 2) &&
        a.charCodeAt(i - 2) === b.charCodeAt(j - 1)
      ) {
        value = Math.min(value, (prevPrev[j - 2] ?? Infinity) + 1) // transposition
      }
      curr.push(value)
    }
    prevPrev = prev
    prev = curr
  }

  return prev[b.length] ?? Math.max(a.length, b.length)
}

/**
 * Match a called tool name against registered names.
 *
 * Auto-matches only when unambiguous: a unique casing/separator/namespace
 * normalization hit, or a unique best edit-distance match within
 * MAX_AUTO_DISTANCE. Ties never match — near pairs like memory_get and
 * memory_set must not be guessed between. When there is no confident match,
 * returns the closest names as suggestions for the error message.
 */
export function matchToolName(name: string, available: string[]): ToolNameMatch {
  if (available.includes(name)) {
    return { match: name, suggestions: [] }
  }

  const forms = candidateForms(name)
  if (forms.length === 0) {
    return { suggestions: [] }
  }

  const normalizedHits = available.filter((a) => forms.includes(normalizeToolName(a)))
  const firstHit = normalizedHits[0]
  if (normalizedHits.length === 1 && firstHit !== undefined) {
    return { match: firstHit, suggestions: [] }
  }
  if (normalizedHits.length > 1) {
    return { suggestions: normalizedHits.slice(0, MAX_SUGGESTIONS) }
  }

  const scored = available
    .map((a) => {
      const normalized = normalizeToolName(a)
      const distance = Math.min(...forms.map((f) => osaDistance(f, normalized)))
      return { name: a, normalized, distance }
    })
    .sort((x, y) => x.distance - y.distance || x.name.localeCompare(y.name))

  const best = scored[0]
  const runnerUp = scored[1]
  if (
    best !== undefined &&
    best.distance <= MAX_AUTO_DISTANCE &&
    best.normalized.length >= MIN_AUTO_MATCH_LENGTH &&
    (runnerUp === undefined || runnerUp.distance > best.distance)
  ) {
    return { match: best.name, suggestions: [] }
  }

  return {
    suggestions: scored
      .filter((s) => s.distance <= MAX_SUGGESTION_DISTANCE)
      .slice(0, MAX_SUGGESTIONS)
      .map((s) => s.name),
  }
}
