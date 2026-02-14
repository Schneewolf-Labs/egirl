import { readFile } from 'fs/promises'
import { isAbsolute, resolve } from 'path'
import type { Tool, ToolResult } from '../types'

export const readTool: Tool = {
  definition: {
    name: 'read_file',
    description: 'Read the contents of a file. Can optionally read a specific range of lines.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The path to the file to read (relative to cwd or absolute)',
        },
        start_line: {
          type: 'number',
          description: 'The starting line number (1-indexed, inclusive)',
        },
        end_line: {
          type: 'number',
          description: 'The ending line number (1-indexed, inclusive)',
        },
      },
      required: ['path'],
    },
  },

  async execute(params: Record<string, unknown>, cwd: string): Promise<ToolResult> {
    const path = params.path as string
    const startLine = params.start_line as number | undefined
    const endLine = params.end_line as number | undefined

    try {
      const fullPath = isAbsolute(path) ? path : resolve(cwd, path)
      const content = await readFile(fullPath, 'utf-8')

      if (startLine !== undefined || endLine !== undefined) {
        const lines = content.split('\n')
        const start = (startLine ?? 1) - 1
        const end = endLine ?? lines.length
        const selectedLines = lines.slice(start, end)

        return {
          success: true,
          output: selectedLines.map((line, i) => `${start + i + 1}: ${line}`).join('\n'),
        }
      }

      return {
        success: true,
        output: content,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        success: false,
        output: `Failed to read file: ${message}`,
      }
    }
  },
}
