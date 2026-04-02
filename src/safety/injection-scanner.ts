/**
 * Prompt injection scanner for tool outputs and external content.
 *
 * Detects common prompt injection patterns in text returned by tools
 * (web_research, browser, file reads, etc.) and either strips them
 * or flags the content for the model.
 *
 * Shared with the memory sanitizer in agent/loop.ts — the patterns
 * are defined once here and re-exported.
 */

/** Patterns that indicate attempted prompt injection */
export const INJECTION_PATTERNS: RegExp[] = [
  // Chat-ML / Instruct format markers
  /<\|im_start\|>/gi,
  /<\|im_end\|>/gi,
  /\[SYSTEM\]/gi,
  /\[INST\]/gi,
  /\[\/INST\]/gi,
  /<<SYS>>/gi,
  /<<\/SYS>>/gi,

  // Override / takeover attempts
  /IGNORE\s+(ALL\s+)?PREVIOUS\s+INSTRUCTIONS/gi,
  /YOU\s+ARE\s+NOW\b/gi,
  /NEW\s+INSTRUCTIONS?\s*:/gi,
  /IMPORTANT\s+UPDATE\s+FROM/gi,
  /OVERRIDE\s+SYSTEM\s+PROMPT/gi,
  /DISREGARD\s+(ALL\s+)?PRIOR/gi,
  /FORGET\s+(ALL\s+)?(YOUR\s+)?INSTRUCTIONS/gi,
  /FROM\s+NOW\s+ON\s+YOU\s+(ARE|WILL)/gi,
  /ACT\s+AS\s+(IF\s+)?YOU\s+ARE/gi,

  // Hidden instruction markers
  /\[HIDDEN\]/gi,
  /<!--\s*(system|instruction|override|ignore)/gi,
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — detecting null byte injection
  /\x00/, // Null bytes used to confuse tokenizers
]

/**
 * Result of scanning content for injection patterns.
 */
export interface ScanResult {
  /** Whether any injection patterns were detected */
  detected: boolean
  /** Number of distinct patterns matched */
  matchCount: number
  /** Names/descriptions of matched patterns for logging */
  matchedPatterns: string[]
  /** Content with injection markers replaced by [filtered] */
  sanitized: string
}

/**
 * Scan a string for prompt injection patterns.
 * Returns a ScanResult with detection info and sanitized content.
 */
export function scanForInjection(content: string): ScanResult {
  const matchedPatterns: string[] = []
  let sanitized = content

  for (const pattern of INJECTION_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0
    if (pattern.test(content)) {
      // Extract pattern description from the regex source
      matchedPatterns.push(pattern.source.slice(0, 40))
      // Reset again before replace
      pattern.lastIndex = 0
      sanitized = sanitized.replace(pattern, '[filtered]')
    }
  }

  // Strip control characters except newlines, tabs, and carriage returns
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — stripping dangerous control chars
  const controlCharPattern = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g
  if (controlCharPattern.test(sanitized)) {
    matchedPatterns.push('control_characters')
    sanitized = sanitized.replace(controlCharPattern, '')
  }

  return {
    detected: matchedPatterns.length > 0,
    matchCount: matchedPatterns.length,
    matchedPatterns,
    sanitized,
  }
}

/**
 * Sanitize content by stripping injection patterns.
 * Convenience wrapper around scanForInjection that just returns the cleaned string.
 */
export function sanitizeContent(content: string): string {
  return scanForInjection(content).sanitized
}
