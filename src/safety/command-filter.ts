/**
 * Command safety filter using an allowlist approach.
 *
 * Instead of trying to block dangerous patterns (trivially bypassable),
 * we parse the command into its base executable and check it against
 * a list of known-safe commands. Anything not on the list is rejected.
 *
 * The allowlist can be extended via config. Pipe chains and subshells
 * are checked — every command in a pipeline must be allowed.
 */

const DEFAULT_ALLOWED_COMMANDS: ReadonlySet<string> = new Set([
  // Version control
  'git',
  'gh',

  // File inspection (read-only)
  'ls',
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'wc',
  'file',
  'stat',
  'du',
  'df',
  'tree',
  'find',
  'which',
  'whereis',
  'realpath',
  'readlink',
  'basename',
  'dirname',

  // Text processing
  'grep',
  'rg',
  'awk',
  'sed',
  'sort',
  'uniq',
  'cut',
  'tr',
  'diff',
  'patch',
  'jq',
  'yq',
  'column',
  'fmt',
  'fold',
  'paste',
  'comm',
  'tee',

  // Build / dev tools
  'bun',
  'bunx',
  'node',
  'npx',
  'npm',
  'pnpm',
  'yarn',
  'deno',
  'cargo',
  'rustc',
  'go',
  'python',
  'python3',
  'pip',
  'pip3',
  'make',
  'cmake',
  'gcc',
  'g++',
  'clang',
  'zig',
  'tsc',
  'esbuild',
  'tsx',

  // System info (read-only)
  'date',
  'uptime',
  'uname',
  'hostname',
  'whoami',
  'id',
  'pwd',
  'echo',
  'printf',
  'true',
  'false',
  'test',

  // File manipulation (agent needs to do work)
  'mkdir',
  'cp',
  'mv',
  'rm',
  'touch',
  'ln',
  'chmod',
  'chown',
  'tar',
  'gzip',
  'gunzip',
  'zip',
  'unzip',
  'dd',

  // Network (read-only)
  'curl',
  'wget',
  'ping',
  'dig',
  'nslookup',
  'host',

  // Process inspection
  'ps',
  'top',
  'htop',
  'pgrep',
  'lsof',

  // Docker
  'docker',
  'docker-compose',
  'podman',

  // Misc dev
  'ssh',
  'scp',
  'rsync',
  'xargs',
  'env',
  'timeout',
  'time',
  'yes',
  'seq',
  'sleep',
])

/** Patterns that are always blocked regardless of allowlist (destructive root operations) */
const HARD_BLOCKED_PATTERNS: RegExp[] = [
  /rm\s+(-\w+\s+)*\//, // rm targeting absolute paths from root
  /mkfs\./, // format filesystem
  /dd\s+.*of=\/dev\//, // direct disk write
  /:\(\)\s*\{/, // fork bomb
  /chmod\s+(-R\s+)?777\s+\//, // world-writable from root paths
  />\s*\/dev\/sd/, // overwrite disk device
  /\b(shutdown|reboot|halt|poweroff)\b/, // power commands
  /pkill\s+-9\s+(init|systemd)/, // kill init
]

export function getDefaultAllowedCommands(): ReadonlySet<string> {
  return DEFAULT_ALLOWED_COMMANDS
}

export function getHardBlockedPatterns(): RegExp[] {
  return [...HARD_BLOCKED_PATTERNS]
}

/**
 * Extract base command names from a shell command string.
 * Handles pipes, &&, ||, ;, and $() subshells.
 */
function extractCommands(command: string): string[] {
  // Split on pipe, &&, ||, ; — these separate independent commands
  const segments = command.split(/\s*(?:\|(?:\|)?|&&|;)\s*/)
  const commands: string[] = []

  for (const segment of segments) {
    const trimmed = segment.trim()
    if (!trimmed) continue

    // Strip leading env var assignments (FOO=bar cmd)
    const withoutEnvVars = trimmed.replace(/^(\w+=\S+\s+)+/, '')

    // Strip leading sudo/nohup/nice/time wrappers
    const withoutPrefixes = withoutEnvVars.replace(
      /^(sudo|nohup|nice|ionice|strace|ltrace|time|command|builtin|exec)\s+(-\S+\s+)*/,
      '',
    )

    // Extract base command (first word)
    const match = withoutPrefixes.match(/^([^\s;|&<>]+)/)
    if (match?.[1]) {
      // Resolve full paths to just the command name
      const cmd = match[1]
      const basename = cmd.includes('/') ? (cmd.split('/').pop() ?? cmd) : cmd
      commands.push(basename)
    }
  }

  // Also extract from $() and backtick subshells
  const subshellMatches = command.matchAll(/\$\(([^)]+)\)|`([^`]+)`/g)
  for (const m of subshellMatches) {
    const inner = m[1] ?? m[2]
    if (inner) {
      commands.push(...extractCommands(inner))
    }
  }

  return commands
}

/**
 * Check if a command is allowed.
 * Returns undefined if allowed, or a rejection reason string if blocked.
 */
export function isCommandAllowed(
  command: string,
  allowedCommands: ReadonlySet<string>,
): string | undefined {
  // Hard-blocked patterns always take priority
  for (const pattern of HARD_BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return `Command matches hard-blocked pattern: ${pattern.source}`
    }
  }

  const commands = extractCommands(command)

  if (commands.length === 0) {
    return 'Could not extract command from input'
  }

  for (const cmd of commands) {
    if (!allowedCommands.has(cmd)) {
      return `Command "${cmd}" is not in the allowed commands list. Allowed: add to [safety.command_filter.extra_allowed] in egirl.toml`
    }
  }

  return undefined
}

// Legacy exports for backward compat during migration
export function getDefaultBlockedPatterns(): RegExp[] {
  return [...HARD_BLOCKED_PATTERNS]
}

export function compilePatterns(patterns: string[]): RegExp[] {
  return patterns.map((p) => new RegExp(p))
}

export function isCommandBlocked(command: string, _patterns: RegExp[]): string | undefined {
  return isCommandAllowed(command, DEFAULT_ALLOWED_COMMANDS)
}
