import type { Tool, ToolResult } from '../../types'
import { apiError, type GitHubConfig, ghFetch, resolveRepo } from './helpers'

export function createGhBranchCreate(config: GitHubConfig): Tool {
  return {
    definition: {
      name: 'gh_branch_create',
      description:
        'Create a new branch on the GitHub remote from a given ref (branch, tag, or SHA).',
      parameters: {
        type: 'object',
        properties: {
          branch: { type: 'string', description: 'Name for the new branch' },
          from: { type: 'string', description: 'Source ref to branch from (default: main)' },
          owner: {
            type: 'string',
            description: 'Repository owner (auto-detected from git remote)',
          },
          repo: { type: 'string', description: 'Repository name (auto-detected from git remote)' },
        },
        required: ['branch'],
      },
    },

    async execute(params: Record<string, unknown>, cwd: string): Promise<ToolResult> {
      const resolved = await resolveRepo(params, cwd, config)
      if (typeof resolved === 'string') return { success: false, output: resolved }

      const { owner, repo } = resolved
      const branch = params.branch as string
      const from = (params.from as string) || 'main'

      // First resolve the source ref to a SHA
      const refRes = await ghFetch(`/repos/${owner}/${repo}/git/ref/heads/${from}`, config.token)

      let sha: string
      if (refRes.status === 200) {
        sha = (refRes.data as { object: { sha: string } }).object.sha
      } else {
        // Try as a tag
        const tagRes = await ghFetch(`/repos/${owner}/${repo}/git/ref/tags/${from}`, config.token)
        if (tagRes.status === 200) {
          sha = (tagRes.data as { object: { sha: string } }).object.sha
        } else {
          // Try as a raw SHA
          const commitRes = await ghFetch(
            `/repos/${owner}/${repo}/git/commits/${from}`,
            config.token,
          )
          if (commitRes.status !== 200) {
            return {
              success: false,
              output: `Could not resolve ref '${from}': ${apiError(refRes.status, refRes.data)}`,
            }
          }
          sha = (commitRes.data as { sha: string }).sha
        }
      }

      const { status, data } = await ghFetch(`/repos/${owner}/${repo}/git/refs`, config.token, {
        method: 'POST',
        body: { ref: `refs/heads/${branch}`, sha },
      })

      if (status !== 201) return { success: false, output: apiError(status, data) }

      return {
        success: true,
        output: `Created branch '${branch}' from ${from} (${sha.slice(0, 7)})`,
      }
    },
  }
}
