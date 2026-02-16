import { spawn } from 'child_process'

const API_BASE = 'https://api.github.com'
const MAX_OUTPUT = 20000

export interface GitHubConfig {
  token: string
  defaultOwner?: string
  defaultRepo?: string
}

export async function ghFetch(
  path: string,
  token: string,
  options: { method?: string; body?: unknown } = {},
): Promise<{ status: number; data: unknown }> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'egirl-agent/1.0',
    },
    ...(options.body != null ? { body: JSON.stringify(options.body) } : {}),
  })

  const data = await response.json()
  return { status: response.status, data }
}

export function truncate(text: string, max = MAX_OUTPUT): string {
  if (text.length <= max) return text
  const half = Math.floor(max / 2)
  const omitted = text.length - max
  return `${text.slice(0, half)}\n\n... (${omitted} characters omitted) ...\n\n${text.slice(-half)}`
}

/**
 * Detect owner/repo from the git remote in the given directory.
 */
function detectRepo(cwd: string): Promise<{ owner: string; repo: string } | undefined> {
  return new Promise((res) => {
    const proc = spawn('git', ['remote', 'get-url', 'origin'], { cwd })
    let stdout = ''
    proc.stdout.on('data', (d) => {
      stdout += d.toString()
    })
    proc.on('error', () => res(undefined))
    proc.on('close', (code) => {
      if (code !== 0) {
        res(undefined)
        return
      }
      const url = stdout.trim()
      // Handle SSH: git@github.com:owner/repo.git
      const sshMatch = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/)
      if (sshMatch) {
        res({ owner: sshMatch[1] ?? '', repo: sshMatch[2] ?? '' })
        return
      }
      // Handle HTTPS: https://github.com/owner/repo.git
      const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/.]+)/)
      if (httpsMatch) {
        res({ owner: httpsMatch[1] ?? '', repo: httpsMatch[2] ?? '' })
        return
      }
      res(undefined)
    })
  })
}

export async function resolveRepo(
  params: Record<string, unknown>,
  cwd: string,
  config: GitHubConfig,
): Promise<{ owner: string; repo: string } | string> {
  const owner = params.owner as string | undefined
  const repo = params.repo as string | undefined

  if (owner && repo) return { owner, repo }

  if (config.defaultOwner && config.defaultRepo) {
    return { owner: config.defaultOwner, repo: config.defaultRepo }
  }

  const detected = await detectRepo(cwd)
  if (detected) return detected

  return 'Could not determine repository. Provide owner and repo parameters, or run from a directory with a GitHub remote.'
}

export function apiError(status: number, data: unknown): string {
  if (typeof data === 'object' && data !== null && 'message' in data) {
    return `GitHub API error (${status}): ${(data as { message: string }).message}`
  }
  return `GitHub API error (${status})`
}

export function resolveHeadRef(cwd: string): Promise<string | undefined> {
  return new Promise((res) => {
    const proc = spawn('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })
    let out = ''
    proc.stdout.on('data', (d) => {
      out += d.toString()
    })
    proc.on('error', () => res(undefined))
    proc.on('close', (code) => res(code === 0 ? out.trim() : undefined))
  })
}
