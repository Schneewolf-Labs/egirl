/**
 * Command safety filter with two modes:
 *
 * - "block" (default): permissive. Everything is allowed except hard-blocked
 *   patterns and user-defined blocked_patterns. The agent can do what it wants.
 *
 * - "allow": restrictive. Only commands in the default allowlist + user-defined
 *   extra_allowed are permitted. Hard blocks still apply on top.
 *
 * Hard-blocked patterns (fork bombs, disk wipes, etc.) are always enforced
 * regardless of mode.
 */

export type CommandFilterMode = 'block' | 'allow'

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

/** Patterns that are always blocked regardless of mode (destructive / dangerous operations) */
const HARD_BLOCKED_PATTERNS: RegExp[] = [
  /rm\s+(-\w+\s+)*\//, // rm targeting absolute paths from root
  /mkfs\./, // format filesystem
  /dd\s+.*of=\/dev\//, // direct disk write
  /:\(\)\s*\{/, // fork bomb
  /chmod\s+(-R\s+)?777\s+\//, // world-writable from root paths
  />\s*\/dev\/sd/, // overwrite disk device
  /\b(shutdown|reboot|halt|poweroff)\b/, // power commands
  /pkill\s+-9\s+(init|systemd)/, // kill init
  /\b(curl|wget)\b.*\|\s*(sh|bash|zsh|dash)/, // pipe remote script to shell
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

export interface CommandFilterConfig {
  mode: CommandFilterMode
  blockPatterns: RegExp[]
  allowedCommands: ReadonlySet<string>
}

/**
 * Check if a command is allowed under the given filter config.
 * Returns undefined if allowed, or a rejection reason if blocked.
 */
export function checkCommand(command: string, config: CommandFilterConfig): string | undefined {
  // Hard-blocked patterns always take priority regardless of mode
  for (const pattern of HARD_BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return `Command matches hard-blocked pattern: ${pattern.source}`
    }
  }

  if (config.mode === 'block') {
    // Block mode: everything allowed unless it matches a user block pattern
    for (const pattern of config.blockPatterns) {
      if (pattern.test(command)) {
        return `Command matches blocked pattern: ${pattern.source}`
      }
    }
    return undefined
  }

  // Allow mode: only listed commands are permitted
  const commands = extractCommands(command)

  if (commands.length === 0) {
    return 'Could not extract command from input'
  }

  for (const cmd of commands) {
    if (!config.allowedCommands.has(cmd)) {
      return `Command "${cmd}" is not in the allowed commands list. Add to [safety.command_filter.extra_allowed] in egirl.toml`
    }
  }

  return undefined
}

/**
 * Build a CommandFilterConfig from runtime config values.
 */
export function buildCommandFilterConfig(
  mode: CommandFilterMode,
  userBlockedPatterns: string[],
  extraAllowed: string[],
): CommandFilterConfig {
  const blockPatterns = userBlockedPatterns.map((p) => new RegExp(p))

  // In allow mode, merge defaults with user extras
  let allowedCommands = DEFAULT_ALLOWED_COMMANDS
  if (extraAllowed.length > 0) {
    const merged = new Set(DEFAULT_ALLOWED_COMMANDS)
    for (const cmd of extraAllowed) {
      merged.add(cmd)
    }
    allowedCommands = merged
  }

  return { mode, blockPatterns, allowedCommands }
}

export function compilePatterns(patterns: string[]): RegExp[] {
  return patterns.map((p) => new RegExp(p))
}
