import type { Tool, ToolResult } from '../types'

const DEFAULT_TIMEOUT = 15000
const DEFAULT_NUM_RESULTS = 10
const MAX_NUM_RESULTS = 25
const MAX_CONTENT_LENGTH = 20000

export interface WebSearchConfig {
  url: string
  apiKey?: string
}

interface SearxngResult {
  url?: string
  title?: string
  content?: string
  engine?: string
  score?: number
  publishedDate?: string
}

interface SearxngResponse {
  query?: string
  number_of_results?: number
  results?: SearxngResult[]
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

function formatResult(r: SearxngResult, index: number): string {
  const parts: string[] = [`${index}. ${r.title ?? '(untitled)'}`]
  if (r.url) parts.push(`   ${r.url}`)
  const meta: string[] = []
  if (r.engine) meta.push(r.engine)
  if (r.publishedDate) meta.push(r.publishedDate)
  if (meta.length > 0) parts.push(`   [${meta.join(' · ')}]`)
  if (r.content) {
    const snippet = r.content.replace(/\s+/g, ' ').trim()
    parts.push(`   ${snippet}`)
  }
  return parts.join('\n')
}

export function createWebSearchTool(config: WebSearchConfig): Tool {
  const baseUrl = normalizeBaseUrl(config.url)

  return {
    definition: {
      name: 'web_search',
      description:
        'Search the web via a SearxNG instance. Returns a list of results with titles, URLs, and snippets. Use web_research afterwards to fetch the full content of a specific result.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query',
          },
          num_results: {
            type: 'number',
            description: `Maximum number of results to return (default: ${DEFAULT_NUM_RESULTS}, max: ${MAX_NUM_RESULTS})`,
          },
          categories: {
            type: 'string',
            description:
              'Comma-separated SearxNG categories (e.g. "general", "news", "it", "science"). Defaults to "general".',
          },
          timeout: {
            type: 'number',
            description: `Request timeout in milliseconds (default: ${DEFAULT_TIMEOUT})`,
          },
        },
        required: ['query'],
      },
    },

    async execute(params: Record<string, unknown>, _cwd: string): Promise<ToolResult> {
      const query = params.query as string
      const numResults = Math.min(
        Math.max(1, (params.num_results as number | undefined) ?? DEFAULT_NUM_RESULTS),
        MAX_NUM_RESULTS,
      )
      const categories = (params.categories as string | undefined) ?? 'general'
      const timeout = (params.timeout as number | undefined) ?? DEFAULT_TIMEOUT

      if (!query || query.trim().length === 0) {
        return { success: false, output: 'query must be a non-empty string' }
      }

      const searchParams = new URLSearchParams({
        q: query,
        format: 'json',
        categories,
      })
      const url = `${baseUrl}/search?${searchParams.toString()}`

      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeout)

        const headers: Record<string, string> = {
          'User-Agent': 'egirl/1.0 (+https://github.com/schneewolf-labs/egirl)',
          Accept: 'application/json',
        }
        if (config.apiKey) {
          headers.Authorization = `Bearer ${config.apiKey}`
        }

        const response = await fetch(url, {
          signal: controller.signal,
          headers,
          redirect: 'follow',
        })

        clearTimeout(timer)

        if (!response.ok) {
          const body = await response.text().catch(() => '')
          const hint =
            response.status === 403 || response.status === 404
              ? ' (SearxNG must have the JSON format enabled in settings.yml — see search.formats)'
              : ''
          return {
            success: false,
            output: `SearxNG returned HTTP ${response.status} ${response.statusText}${hint}${body ? `\n${body.slice(0, 500)}` : ''}`,
          }
        }

        const data = (await response.json()) as SearxngResponse
        const results = data.results ?? []

        if (results.length === 0) {
          return { success: true, output: `No results for "${query}".` }
        }

        const trimmed = results.slice(0, numResults)
        const header = `Found ${results.length} result${results.length === 1 ? '' : 's'} for "${query}" (showing ${trimmed.length}):\n`
        let output = header + trimmed.map((r, i) => formatResult(r, i + 1)).join('\n\n')

        if (output.length > MAX_CONTENT_LENGTH) {
          output = `${output.slice(0, MAX_CONTENT_LENGTH)}\n\n[Truncated — output exceeded ${MAX_CONTENT_LENGTH} characters]`
        }

        return { success: true, output }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)

        if (message.includes('abort')) {
          return {
            success: false,
            output: `Request timed out after ${timeout}ms`,
          }
        }

        return {
          success: false,
          output: `Failed to query SearxNG: ${message}`,
        }
      }
    },
  }
}
