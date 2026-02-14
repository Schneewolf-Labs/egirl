const DEFAULT_BLOCKED_PATTERNS: RegExp[] = [
  /rm\s+(-\w+\s+)*\//,                    // rm targeting root
  /mkfs\./,                                // format filesystem
  /dd\s+.*of=\/dev\//,                     // direct disk write
  /:\(\)\s*\{/,                            // fork bomb
  /chmod\s+(-R\s+)?777\s+\//,             // world-writable from root
  /curl\s+.*\|\s*(ba)?sh/,                // pipe curl to shell
  /wget\s+.*\|\s*(ba)?sh/,                // pipe wget to shell
  />\s*\/dev\/sd/,                         // overwrite disk device
  /\b(shutdown|reboot|halt|poweroff)\b/,   // power commands
  /pkill\s+-9\s+(init|systemd)/,           // kill init process
]

export function getDefaultBlockedPatterns(): RegExp[] {
  return [...DEFAULT_BLOCKED_PATTERNS]
}

export function compilePatterns(patterns: string[]): RegExp[] {
  return patterns.map(p => new RegExp(p))
}

export function isCommandBlocked(command: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    if (pattern.test(command)) {
      return `Command matches blocked pattern: ${pattern.source}`
    }
  }
  return undefined
}
