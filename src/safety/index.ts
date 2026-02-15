import { type AuditEntry, appendAuditLog } from './audit-log'
import { getDefaultBlockedPatterns, isCommandBlocked } from './command-filter'
import { getDefaultSensitivePatterns, isPathAllowed, isSensitivePath } from './path-guard'

export type { AuditEntry, AuditMemoryEntry, AuditAPIEntry } from './audit-log'
export { appendAuditLog, auditMemoryOperation, auditAPIRequest } from './audit-log'
export { compilePatterns, getDefaultBlockedPatterns, getDefaultAllowedCommands } from './command-filter'
export { getDefaultSensitivePatterns } from './path-guard'

export interface SafetyConfig {
  enabled: boolean
  commandFilter: {
    enabled: boolean
    patterns: RegExp[]
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
  confirmation: {
    enabled: boolean
    tools: string[]
  }
}

const FILE_TOOLS = ['read_file', 'write_file', 'edit_file', 'glob_files']
const SENSITIVE_CHECK_TOOLS = ['read_file', 'write_file', 'edit_file']

export type SafetyCheckResult =
  | { allowed: true }
  | { allowed: false; reason: string; needsConfirmation?: boolean }

export function getDefaultSafetyConfig(): SafetyConfig {
  return {
    enabled: true,
    commandFilter: {
      enabled: true,
      patterns: getDefaultBlockedPatterns(),
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
    confirmation: {
      enabled: false,
      tools: ['execute_command', 'write_file', 'edit_file'],
    },
  }
}

function extractPath(args: Record<string, unknown>): string | undefined {
  return (args.path as string | undefined) ?? (args.working_dir as string | undefined)
}

export function checkToolCall(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
  config: SafetyConfig,
): SafetyCheckResult {
  if (!config.enabled) return { allowed: true }

  // Command blocklist
  if (config.commandFilter.enabled && toolName === 'execute_command' && args.command) {
    const blocked = isCommandBlocked(args.command as string, config.commandFilter.patterns)
    if (blocked) return { allowed: false, reason: blocked }
  }

  // Path sandboxing
  if (config.pathSandbox.enabled && FILE_TOOLS.includes(toolName)) {
    const filePath = extractPath(args)
    if (filePath && config.pathSandbox.allowedPaths.length > 0) {
      const denied = isPathAllowed(filePath, cwd, config.pathSandbox.allowedPaths)
      if (denied) return { allowed: false, reason: denied }
    }
  }

  // Sensitive file guard
  if (config.sensitiveFiles.enabled && SENSITIVE_CHECK_TOOLS.includes(toolName)) {
    const filePath = extractPath(args)
    if (filePath) {
      const sensitive = isSensitivePath(filePath, cwd, config.sensitiveFiles.patterns)
      if (sensitive) return { allowed: false, reason: sensitive }
    }
  }

  // Confirmation mode
  if (config.confirmation.enabled && config.confirmation.tools.includes(toolName)) {
    return {
      allowed: false,
      reason: `Tool "${toolName}" requires confirmation (safety.confirmation.enabled is on)`,
      needsConfirmation: true,
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
