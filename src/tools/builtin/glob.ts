import { resolve, isAbsolute } from 'path'
import type { Tool, ToolContext, ToolResult } from '../types'

interface GlobParams {
  pattern: string
  cwd?: string
}

export const globTool: Tool = {
  definition: {
    name: 'glob_files',
    description: 'Find files matching a glob pattern',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'The glob pattern to match (e.g., "**/*.ts", "src/**/*.js")',
        },
        cwd: {
          type: 'string',
          description: 'The directory to search in (defaults to workspace)',
        },
      },
      required: ['pattern'],
    },
  },

  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const { pattern, cwd } = params as GlobParams

    const workingDir = cwd
      ? (isAbsolute(cwd) ? cwd : resolve(context.workspaceDir, cwd))
      : context.workspaceDir

    try {
      // Use Bun's native glob
      const glob = new Bun.Glob(pattern)
      const matches: string[] = []

      for await (const file of glob.scan({ cwd: workingDir, onlyFiles: true })) {
        matches.push(file)
      }

      if (matches.length === 0) {
        return {
          success: true,
          output: 'No files found matching the pattern.',
        }
      }

      return {
        success: true,
        output: matches.join('\n'),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        success: false,
        output: `Failed to glob files: ${message}`,
      }
    }
  },
}
