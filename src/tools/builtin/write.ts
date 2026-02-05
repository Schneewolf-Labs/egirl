import { writeFile, mkdir } from 'fs/promises'
import { resolve, isAbsolute, dirname } from 'path'
import type { Tool, ToolResult } from '../types'

export const writeTool: Tool = {
  definition: {
    name: 'write_file',
    description: 'Write content to a file. Creates the file if it does not exist.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The path to the file to write (relative to cwd or absolute)',
        },
        content: {
          type: 'string',
          description: 'The content to write to the file',
        },
        create_directories: {
          type: 'boolean',
          description: 'Whether to create parent directories if they do not exist',
          default: true,
        },
      },
      required: ['path', 'content'],
    },
  },

  async execute(params: Record<string, unknown>, cwd: string): Promise<ToolResult> {
    const path = params.path as string
    const content = params.content as string
    const createDirectories = params.create_directories !== false

    try {
      const fullPath = isAbsolute(path) ? path : resolve(cwd, path)

      if (createDirectories) {
        await mkdir(dirname(fullPath), { recursive: true })
      }

      await writeFile(fullPath, content, 'utf-8')

      return {
        success: true,
        output: `Successfully wrote ${content.length} characters to ${path}`,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        success: false,
        output: `Failed to write file: ${message}`,
      }
    }
  },
}
