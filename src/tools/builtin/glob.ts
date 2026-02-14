import { isAbsolute, resolve } from 'path'
import type { Tool, ToolResult } from '../types'

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
        dir: {
          type: 'string',
          description: 'The directory to search in (defaults to cwd)',
        },
      },
      required: ['pattern'],
    },
  },

  async execute(params: Record<string, unknown>, cwd: string): Promise<ToolResult> {
    const pattern = params.pattern as string
    const dir = params.dir as string | undefined

    const workingDir = dir ? (isAbsolute(dir) ? dir : resolve(cwd, dir)) : cwd

    try {
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
