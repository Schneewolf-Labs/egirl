import { realpathSync } from 'fs'
import { isAbsolute, normalize, resolve } from 'path'

const DEFAULT_SENSITIVE_PATTERNS: RegExp[] = [
  // Environment / dotenv
  /\.env$/,
  /\.env\.[^/]+$/,

  // SSH keys and config
  /id_rsa/,
  /id_ed25519/,
  /id_ecdsa/,
  /id_dsa/,
  /\.ssh\/config$/,
  /\.ssh\/known_hosts$/,
  /authorized_keys$/,

  // Certificates and private keys
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.pfx$/,
  /\.crt$/,
  /\.keystore$/,

  // Package manager credentials
  /\.npmrc$/,
  /\.pypirc$/,
  /\.gem\/credentials$/,

  // Cloud and infra credentials
  /\.aws\/credentials$/,
  /\.aws\/config$/,
  /\.docker\/config\.json$/,
  /\.kube\/config$/,
  /kubeconfig$/,

  // Git credentials
  /credentials\.json$/,
  /\.git-credentials$/,
  /\.netrc$/,

  // OAuth and API tokens
  /token\.json$/,
  /oauth.*\.json$/i,

  // Secrets files
  /\.secrets$/,
  /secrets\.ya?ml$/i,
  /secrets\.json$/i,
]

export function getDefaultSensitivePatterns(): RegExp[] {
  return [...DEFAULT_SENSITIVE_PATTERNS]
}

/**
 * Resolve a file path to its real location, following symlinks.
 * Falls back to normalize() if realpath fails (file doesn't exist yet).
 */
function safeRealpath(filePath: string): string {
  try {
    return realpathSync(filePath)
  } catch {
    // File doesn't exist yet (e.g., write_file to new path) — use normalize
    return normalize(filePath)
  }
}

export function isPathAllowed(
  filePath: string,
  cwd: string,
  allowedPaths: string[],
): string | undefined {
  if (allowedPaths.length === 0) return undefined

  const resolved = isAbsolute(filePath) ? filePath : resolve(cwd, filePath)
  const fullPath = safeRealpath(resolved)

  for (const allowed of allowedPaths) {
    const normalizedAllowed = safeRealpath(normalize(allowed))
    if (fullPath === normalizedAllowed || fullPath.startsWith(`${normalizedAllowed}/`)) {
      return undefined
    }
  }

  return `Path "${filePath}" is outside allowed directories: ${allowedPaths.join(', ')}`
}

export function isSensitivePath(
  filePath: string,
  cwd: string,
  patterns: RegExp[],
): string | undefined {
  const resolved = isAbsolute(filePath) ? filePath : resolve(cwd, filePath)
  const fullPath = safeRealpath(resolved)

  for (const pattern of patterns) {
    if (pattern.test(fullPath)) {
      return `Path "${filePath}" matches sensitive file pattern: ${pattern.source}`
    }
  }

  return undefined
}
