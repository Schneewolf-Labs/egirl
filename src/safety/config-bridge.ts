import type { RuntimeConfig } from '../config'
import type { SafetyConfig } from './index'
import { getDefaultBlockedPatterns, compilePatterns } from './command-filter'
import { getDefaultSensitivePatterns } from './path-guard'

export function buildSafetyConfig(config: RuntimeConfig): SafetyConfig {
  const safety = config.safety

  const userBlockedPatterns = safety.blockedPatterns.length > 0
    ? compilePatterns(safety.blockedPatterns)
    : []

  const userSensitivePatterns = safety.sensitivePatterns.length > 0
    ? compilePatterns(safety.sensitivePatterns)
    : []

  return {
    enabled: safety.enabled,
    auditLog: safety.auditLog,
    blockedPatterns: [...getDefaultBlockedPatterns(), ...userBlockedPatterns],
    allowedPaths: safety.allowedPaths,
    sensitivePatterns: [...getDefaultSensitivePatterns(), ...userSensitivePatterns],
    requireConfirmation: safety.requireConfirmation,
    confirmableTools: ['execute_command', 'write_file', 'edit_file'],
  }
}
