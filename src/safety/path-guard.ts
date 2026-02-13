import { resolve, isAbsolute, normalize } from 'path'

const DEFAULT_SENSITIVE_PATTERNS: RegExp[] = [
  /\.env$/,
  /\.env\.[^/]+$/,
  /id_rsa/,
  /id_ed25519/,
  /id_ecdsa/,
  /\.pem$/,
  /\.key$/,
  /\.ssh\/config$/,
  /\.npmrc$/,
  /\.pypirc$/,
  /credentials\.json$/,
  /\.git-credentials$/,
  /\.aws\/credentials$/,
  /\.docker\/config\.json$/,
]

export function getDefaultSensitivePatterns(): RegExp[] {
  return [...DEFAULT_SENSITIVE_PATTERNS]
}

export function isPathAllowed(
  filePath: string,
  cwd: string,
  allowedPaths: string[],
): string | undefined {
  if (allowedPaths.length === 0) return undefined

  const fullPath = normalize(isAbsolute(filePath) ? filePath : resolve(cwd, filePath))

  for (const allowed of allowedPaths) {
    const normalizedAllowed = normalize(allowed)
    if (fullPath === normalizedAllowed || fullPath.startsWith(normalizedAllowed + '/')) {
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
  const fullPath = normalize(isAbsolute(filePath) ? filePath : resolve(cwd, filePath))

  for (const pattern of patterns) {
    if (pattern.test(fullPath)) {
      return `Path "${filePath}" matches sensitive file pattern: ${pattern.source}`
    }
  }

  return undefined
}
