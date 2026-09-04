import { gitStdout } from '../../../util/git'

const API_BASE = 'https://api.github.com'

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

/**
 * Detect owner/repo from the git remote in the given directory.
 */
async function detectRepo(cwd: string): Promise<{ owner: string; repo: string } | undefined> {
  const url = (await gitStdout(['remote', 'get-url', 'origin'], cwd))?.trim()
  if (!url) return undefined
  // SSH (git@github.com:owner/repo.git) or HTTPS (https://github.com/owner/repo.git)
  const match = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/)
  return match ? { owner: match[1] ?? '', repo: match[2] ?? '' } : undefined
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

export async function resolveHeadRef(cwd: string): Promise<string | undefined> {
  return (await gitStdout(['rev-parse', '--abbrev-ref', 'HEAD'], cwd))?.trim()
}
