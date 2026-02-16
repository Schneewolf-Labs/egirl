import type { Tool, ToolResult } from '../../types'
import { apiError, type GitHubConfig, ghFetch, resolveRepo, truncate } from './helpers'

export function createGhReleaseList(config: GitHubConfig): Tool {
  return {
    definition: {
      name: 'gh_release_list',
      description: 'List recent releases for a GitHub repository.',
      parameters: {
        type: 'object',
        properties: {
          owner: {
            type: 'string',
            description: 'Repository owner (auto-detected from git remote)',
          },
          repo: { type: 'string', description: 'Repository name (auto-detected from git remote)' },
          limit: {
            type: 'number',
            description: 'Maximum number of releases to return (default: 5)',
          },
        },
        required: [],
      },
    },

    async execute(params: Record<string, unknown>, cwd: string): Promise<ToolResult> {
      const resolved = await resolveRepo(params, cwd, config)
      if (typeof resolved === 'string') return { success: false, output: resolved }

      const { owner, repo } = resolved
      const limit = Math.min((params.limit as number) || 5, 30)

      const res = await ghFetch(`/repos/${owner}/${repo}/releases?per_page=${limit}`, config.token)

      if (res.status !== 200) {
        return { success: false, output: apiError(res.status, res.data) }
      }

      const releases = res.data as Array<{
        tag_name: string
        name: string | null
        draft: boolean
        prerelease: boolean
        published_at: string | null
        html_url: string
        body: string | null
        author: { login: string } | null
      }>

      if (releases.length === 0) {
        return { success: true, output: `No releases found for ${owner}/${repo}` }
      }

      const lines: string[] = [`Releases for ${owner}/${repo}:\n`]

      for (const r of releases) {
        const flags: string[] = []
        if (r.draft) flags.push('draft')
        if (r.prerelease) flags.push('pre-release')
        const flagStr = flags.length > 0 ? ` [${flags.join(', ')}]` : ''
        const date = r.published_at ? r.published_at.split('T')[0] : 'unpublished'
        const author = r.author?.login ?? 'unknown'
        const name = r.name && r.name !== r.tag_name ? ` — ${r.name}` : ''

        lines.push(`${r.tag_name}${name}${flagStr}`)
        lines.push(`  published: ${date} by ${author}`)
        lines.push(`  url: ${r.html_url}`)

        if (r.body) {
          const summary = r.body.split('\n').slice(0, 3).join('\n').trim()
          if (summary) {
            lines.push(`  ${summary}`)
          }
        }
        lines.push('')
      }

      return { success: true, output: truncate(lines.join('\n')) }
    },
  }
}
