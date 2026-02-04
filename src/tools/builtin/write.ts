import { writeFile, mkdir } from 'fs/promises'
import { resolve, isAbsolute, dirname } from 'path'
import type { Tool, ToolContext, ToolResult } from '../types'

interface WriteParams {
  path: string
  content: string
  createDirectories?: boolean
}

export const writeTool: Tool = {
  definition: {
    name: 'write_file',
    description: 'Write content to a file. Creates the file if it does not exist.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The path to the file to write (relative to workspace or absolute)',
        },
        content: {
          type: 'string',
          description: 'The content to write to the file',
        },
        createDirectories: {
          type: 'boolean',
          description: 'Whether to create parent directories if they do not exist',
          default: true,
        },
      },
      required: ['path', 'content'],
    },
  },

  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const { path, content, createDirectories = true } = params as WriteParams

    try {
      const fullPath = isAbsolute(path) ? path : resolve(context.workspaceDir, path)

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
