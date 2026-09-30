import { HANDLE_RE } from '../agent/attachments'
import { type AuditEntry, appendAuditLog } from './audit-log'
import { buildCommandFilterConfig, type CommandFilterConfig, checkCommand } from './command-filter'
import { getDefaultSensitivePatterns, isPathAllowed, isSensitivePath } from './path-guard'
import { checkPermissionRules, type PermissionRule } from './permission-rules'

export type { AuditEntry, AuditMemoryEntry } from './audit-log'
export { appendAuditLog, auditMemoryOperation } from './audit-log'
export {
  buildCommandFilterConfig,
  type CommandFilterConfig,
  compilePatterns,
} from './command-filter'
export { type ScanResult, sanitizeContent, scanForInjection } from './injection-scanner'
export { getDefaultSensitivePatterns } from './path-guard'
export {
  checkPermissionRules,
  compilePermissionRules,
  globToRegex,
  type PermissionRule,
  parseRule,
} from './permission-rules'

export interface SafetyConfig {
  enabled: boolean
  commandFilter: {
    enabled: boolean
    config: CommandFilterConfig
  }
  pathSandbox: {
    enabled: boolean
    allowedPaths: string[]
  }
  sensitiveFiles: {
    enabled: boolean
    patterns: RegExp[]
  }
  auditLog: {
    enabled: boolean
    path?: string
  }
  /** Pattern-based permission rules — evaluated before other checks. First match wins. */
  permissionRules: PermissionRule[]
}

// consult reads the files it attaches and ships them to a consultant model, so its `files`
// go through the same sandbox and sensitive-file checks as read_file.
const FILE_TOOLS = ['read_file', 'write_file', 'edit_file', 'glob_files', 'consult']
const SENSITIVE_CHECK_TOOLS = ['read_file', 'write_file', 'edit_file', 'consult']

export type SafetyCheckResult =
  | { allowed: true }
  | { allowed: false; reason: string; needsConfirmation?: boolean }

export function getDefaultSafetyConfig(): SafetyConfig {
  return {
    enabled: true,
    commandFilter: {
      enabled: true,
      config: buildCommandFilterConfig('block', [], []),
    },
    pathSandbox: {
      enabled: true,
      allowedPaths: [],
    },
    sensitiveFiles: {
      enabled: true,
      patterns: getDefaultSensitivePatterns(),
    },
    auditLog: {
      enabled: true,
    },
    // Confirmation mode is intentionally disabled by default.
    // egirl is a single-user local-first agent — the operator trusts the agent
    // to execute commands autonomously. Enable via egirl.toml if you want
    // interactive approval before execute_command/write_file/edit_file.
    permissionRules: [],
  }
}

function extractPaths(toolName: string, args: Record<string, unknown>): string[] {
  if (toolName === 'consult') {
    // Image handles (img1) name this session's attachments; anything else is a path.
    const images = Array.isArray(args.images)
      ? args.images.filter((i): i is string => typeof i === 'string' && !HANDLE_RE.test(i.trim()))
      : []
    const files = Array.isArray(args.files)
      ? args.files.filter((f): f is string => typeof f === 'string')
      : []
    return [...files, ...images]
  }
  const path = (args.path as string | undefined) ?? (args.working_dir as string | undefined)
  return path ? [path] : []
}

export function checkToolCall(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
  config: SafetyConfig,
): SafetyCheckResult {
  if (!config.enabled) return { allowed: true }

  // Pattern-based permission rules — first match wins, evaluated before other checks
  if (config.permissionRules.length > 0) {
    const ruleResult = checkPermissionRules(toolName, args, config.permissionRules)
    if (ruleResult === 'deny') {
      return { allowed: false, reason: `Denied by permission rule for tool "${toolName}"` }
    }
    if (ruleResult === 'allow') {
      return { allowed: true }
    }
    // undefined = no rule matched, fall through to other checks
  }

  // Command filter
  if (config.commandFilter.enabled && toolName === 'execute_command' && args.command) {
    const blocked = checkCommand(args.command as string, config.commandFilter.config)
    if (blocked) return { allowed: false, reason: blocked }
  }

  // Path sandboxing
  if (
    config.pathSandbox.enabled &&
    FILE_TOOLS.includes(toolName) &&
    config.pathSandbox.allowedPaths.length > 0
  ) {
    for (const filePath of extractPaths(toolName, args)) {
      const denied = isPathAllowed(filePath, cwd, config.pathSandbox.allowedPaths)
      if (denied) return { allowed: false, reason: denied }
    }
  }

  // Sensitive file guard
  if (config.sensitiveFiles.enabled && SENSITIVE_CHECK_TOOLS.includes(toolName)) {
    for (const filePath of extractPaths(toolName, args)) {
      const sensitive = isSensitivePath(filePath, cwd, config.sensitiveFiles.patterns)
      if (sensitive) return { allowed: false, reason: sensitive }
    }
  }

  return { allowed: true }
}

export function getAuditLogPath(config: SafetyConfig): string | undefined {
  if (!config.enabled || !config.auditLog.enabled) return undefined
  return config.auditLog.path
}

export async function logToolExecution(
  toolName: string,
  args: Record<string, unknown>,
  result: { success: boolean; blocked?: boolean; reason?: string },
  logPath: string,
): Promise<void> {
  const entry: AuditEntry = {
    timestamp: new Date().toISOString(),
    tool: toolName,
    args,
    blocked: result.blocked ?? false,
    reason: result.reason,
    success: result.success,
  }

  await appendAuditLog(entry, logPath)
}
