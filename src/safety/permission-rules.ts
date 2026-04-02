// Pattern-based permission rules for tool calls.
//
// Supports glob-like patterns for fine-grained tool access control:
//   "execute_command(git *)"      — allow git commands
//   "read_file(/home/user/**)"    — allow reading from home dir
//   "write_file(/src/**/*.ts)"    — allow writing TS files in src
//   "execute_command(rm *)"       — deny rm commands
//   "*"                           — match any tool
//
// Rules are evaluated in order: first match wins.
// If no rule matches, the default action applies.

export interface PermissionRule {
  /** 'allow' or 'deny' */
  action: 'allow' | 'deny'
  /** Tool name pattern (supports * wildcard) */
  tool: string
  /** Argument pattern (optional, supports * and ** wildcards). Matched against the first string arg. */
  argPattern?: string
  /** Compiled regex from tool pattern */
  _toolRegex: RegExp
  /** Compiled regex from arg pattern */
  _argRegex?: RegExp
}

/**
 * Parse a permission rule string into a PermissionRule.
 *
 * Format: "tool_name" or "tool_name(arg_pattern)"
 * Wildcards: * matches any segment, ** matches anything including /
 *
 * Examples:
 *   "execute_command(git *)"
 *   "read_file(/home/**)"
 *   "write_file"
 *   "*"
 */
export function parseRule(ruleStr: string, action: 'allow' | 'deny'): PermissionRule {
  const parenIdx = ruleStr.indexOf('(')
  let toolPattern: string
  let argPattern: string | undefined

  if (parenIdx !== -1 && ruleStr.endsWith(')')) {
    toolPattern = ruleStr.slice(0, parenIdx)
    argPattern = ruleStr.slice(parenIdx + 1, -1)
  } else {
    toolPattern = ruleStr
  }

  return {
    action,
    tool: toolPattern,
    argPattern,
    _toolRegex: globToRegex(toolPattern),
    _argRegex: argPattern ? globToRegex(argPattern) : undefined,
  }
}

/**
 * Convert a glob pattern to a RegExp.
 * - ** matches any character sequence (including /)
 * - * matches any character sequence except /
 * - ? matches a single character
 * - Other regex specials are escaped
 */
export function globToRegex(pattern: string): RegExp {
  let result = ''
  let i = 0

  while (i < pattern.length) {
    const char = pattern[i]

    if (char === '*' && pattern[i + 1] === '*') {
      result += '.*'
      i += 2
      // Skip trailing / after **
      if (pattern[i] === '/') i++
    } else if (char === '*') {
      result += '[^/]*'
      i++
    } else if (char === '?') {
      result += '.'
      i++
    } else if (
      // biome-ignore lint/suspicious/noTemplateCurlyInString: not a template — literal regex special chars
      '.+^${}()|[]\\'.includes(char as string)
    ) {
      result += `\\${char}`
      i++
    } else {
      result += char
      i++
    }
  }

  return new RegExp(`^${result}$`)
}

/**
 * Extract the primary string argument from tool call arguments.
 * Uses heuristics: looks for 'command', 'path', 'url', 'query', then first string value.
 */
function extractPrimaryArg(args: Record<string, unknown>): string | undefined {
  // Try known arg names in priority order
  for (const key of ['command', 'path', 'file_path', 'url', 'query', 'pattern']) {
    if (typeof args[key] === 'string') return args[key] as string
  }
  // Fallback: first string value
  for (const val of Object.values(args)) {
    if (typeof val === 'string') return val
  }
  return undefined
}

/**
 * Check a tool call against an ordered list of permission rules.
 * Returns the action of the first matching rule, or undefined if no rule matches.
 */
export function checkPermissionRules(
  toolName: string,
  args: Record<string, unknown>,
  rules: PermissionRule[],
): 'allow' | 'deny' | undefined {
  const primaryArg = extractPrimaryArg(args)

  for (const rule of rules) {
    // Check tool name
    if (!rule._toolRegex.test(toolName)) continue

    // If no arg pattern, tool match is sufficient
    if (!rule._argRegex) return rule.action

    // Check argument pattern
    if (primaryArg && rule._argRegex.test(primaryArg)) return rule.action
  }

  return undefined
}

/**
 * Parse allow/deny rule lists from config into compiled PermissionRule arrays.
 */
export function compilePermissionRules(allow: string[], deny: string[]): PermissionRule[] {
  // Deny rules are checked first (higher priority)
  const rules: PermissionRule[] = []
  for (const d of deny) {
    rules.push(parseRule(d, 'deny'))
  }
  for (const a of allow) {
    rules.push(parseRule(a, 'allow'))
  }
  return rules
}
