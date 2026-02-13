import type { Tool, ToolResult } from '../types'

const DEFAULT_TIMEOUT = 15000
const MAX_CONTENT_LENGTH = 50000

/**
 * Strip HTML tags and extract readable text content.
 * Handles common elements like scripts, styles, and whitespace.
 */
function htmlToText(html: string): string {
  let text = html

  // Remove script and style blocks entirely
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '')
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '')
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, '')

  // Replace common block elements with newlines
  text = text.replace(/<\/?(p|div|br|hr|h[1-6]|li|tr|blockquote|pre|section|article|header|footer|nav|main)[\s>][^>]*>/gi, '\n')
  text = text.replace(/<br\s*\/?>/gi, '\n')

  // Remove all remaining HTML tags
  text = text.replace(/<[^>]+>/g, '')

  // Decode common HTML entities
  text = text.replace(/&amp;/g, '&')
  text = text.replace(/&lt;/g, '<')
  text = text.replace(/&gt;/g, '>')
  text = text.replace(/&quot;/g, '"')
  text = text.replace(/&#39;/g, "'")
  text = text.replace(/&nbsp;/g, ' ')
  text = text.replace(/&#(\d+);/g, (_match, dec) => String.fromCharCode(Number(dec)))

  // Collapse whitespace: multiple spaces to single, preserve newlines
  text = text.replace(/[ \t]+/g, ' ')
  text = text.replace(/\n[ \t]+/g, '\n')
  text = text.replace(/[ \t]+\n/g, '\n')
  text = text.replace(/\n{3,}/g, '\n\n')

  return text.trim()
}

export const webResearchTool: Tool = {
  definition: {
    name: 'web_research',
    description: 'Fetch a URL and return its text content. Useful for reading web pages, documentation, API responses, and other online resources.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to fetch (must start with http:// or https://)',
        },
        timeout: {
          type: 'number',
          description: `Request timeout in milliseconds (default: ${DEFAULT_TIMEOUT})`,
        },
      },
      required: ['url'],
    },
  },

  async execute(params: Record<string, unknown>, _cwd: string): Promise<ToolResult> {
    const url = params.url as string
    const timeout = (params.timeout as number | undefined) ?? DEFAULT_TIMEOUT

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return {
        success: false,
        output: 'URL must start with http:// or https://',
      }
    }

    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout)

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'egirl-agent/1.0',
          'Accept': 'text/html, application/json, text/plain, */*',
        },
        redirect: 'follow',
      })

      clearTimeout(timer)

      if (!response.ok) {
        return {
          success: false,
          output: `HTTP ${response.status} ${response.statusText}`,
        }
      }

      const contentType = response.headers.get('content-type') ?? ''
      const raw = await response.text()

      let content: string
      if (contentType.includes('application/json')) {
        // Pretty-print JSON for readability
        try {
          content = JSON.stringify(JSON.parse(raw), null, 2)
        } catch {
          content = raw
        }
      } else if (contentType.includes('text/html')) {
        content = htmlToText(raw)
      } else {
        // Plain text or other text formats
        content = raw
      }

      // Truncate if too long
      if (content.length > MAX_CONTENT_LENGTH) {
        content = content.slice(0, MAX_CONTENT_LENGTH) + `\n\n[Truncated — content exceeded ${MAX_CONTENT_LENGTH} characters]`
      }

      return {
        success: true,
        output: content,
      }
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
        output: `Failed to fetch URL: ${message}`,
      }
    }
  },
}
