import { isCommandBlocked, getDefaultBlockedPatterns, compilePatterns } from './command-filter'
import { isPathAllowed, isSensitivePath, getDefaultSensitivePatterns } from './path-guard'
import { appendAuditLog, type AuditEntry } from './audit-log'

export { type AuditEntry } from './audit-log'
export { getDefaultBlockedPatterns, compilePatterns } from './command-filter'
export { getDefaultSensitivePatterns } from './path-guard'

export interface SafetyConfig {
  enabled: boolean
  auditLog?: string
  blockedPatterns: RegExp[]
  allowedPaths: string[]
  sensitivePatterns: RegExp[]
  requireConfirmation: boolean
  confirmableTools: string[]
}

const DEFAULT_CONFIRMABLE_TOOLS = ['execute_command', 'write_file', 'edit_file']

const FILE_TOOLS = ['read_file', 'write_file', 'edit_file', 'glob_files']
const SENSITIVE_CHECK_TOOLS = ['read_file', 'write_file', 'edit_file']

export type SafetyCheckResult =
  | { allowed: true }
  | { allowed: false; reason: string; needsConfirmation?: boolean }

export function getDefaultSafetyConfig(): SafetyConfig {
  return {
    enabled: true,
    blockedPatterns: getDefaultBlockedPatterns(),
    allowedPaths: [],
    sensitivePatterns: getDefaultSensitivePatterns(),
    requireConfirmation: false,
    confirmableTools: [...DEFAULT_CONFIRMABLE_TOOLS],
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
  if (toolName === 'execute_command' && args.command) {
    const blocked = isCommandBlocked(args.command as string, config.blockedPatterns)
    if (blocked) return { allowed: false, reason: blocked }
  }

  // Path sandboxing
  if (FILE_TOOLS.includes(toolName)) {
    const filePath = extractPath(args)
    if (filePath && config.allowedPaths.length > 0) {
      const denied = isPathAllowed(filePath, cwd, config.allowedPaths)
      if (denied) return { allowed: false, reason: denied }
    }
  }

  // Sensitive file guard
  if (SENSITIVE_CHECK_TOOLS.includes(toolName)) {
    const filePath = extractPath(args)
    if (filePath) {
      const sensitive = isSensitivePath(filePath, cwd, config.sensitivePatterns)
      if (sensitive) return { allowed: false, reason: sensitive }
    }
  }

  // Confirmation mode
  if (config.requireConfirmation && config.confirmableTools.includes(toolName)) {
    return {
      allowed: false,
      reason: `Tool "${toolName}" requires confirmation (safety.require_confirmation is enabled)`,
      needsConfirmation: true,
    }
  }

  return { allowed: true }
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
