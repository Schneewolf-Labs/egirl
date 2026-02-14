import type { RuntimeConfig } from '../config'
import type { SafetyConfig } from './index'
import { getDefaultBlockedPatterns, compilePatterns } from './command-filter'
import { getDefaultSensitivePatterns } from './path-guard'

export function buildSafetyConfig(config: RuntimeConfig): SafetyConfig {
  const safety = config.safety

  const userBlockedPatterns = safety.commandFilter.blockedPatterns.length > 0
    ? compilePatterns(safety.commandFilter.blockedPatterns)
    : []

  const userSensitivePatterns = safety.sensitiveFiles.patterns.length > 0
    ? compilePatterns(safety.sensitiveFiles.patterns)
    : []

  return {
    enabled: safety.enabled,
    commandFilter: {
      enabled: safety.commandFilter.enabled,
      patterns: [...getDefaultBlockedPatterns(), ...userBlockedPatterns],
    },
    pathSandbox: {
      enabled: safety.pathSandbox.enabled,
      allowedPaths: safety.pathSandbox.allowedPaths,
    },
    sensitiveFiles: {
      enabled: safety.sensitiveFiles.enabled,
      patterns: [...getDefaultSensitivePatterns(), ...userSensitivePatterns],
    },
    auditLog: {
      enabled: safety.auditLog.enabled,
      path: safety.auditLog.path,
    },
    confirmation: {
      enabled: safety.confirmation.enabled,
      tools: safety.confirmation.tools,
    },
  }
}
