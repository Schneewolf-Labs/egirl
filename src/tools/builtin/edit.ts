import { readFile, writeFile } from 'fs/promises'
import { resolve, isAbsolute } from 'path'
import type { Tool, ToolContext, ToolResult } from '../types'

interface EditParams {
  path: string
  oldText: string
  newText: string
}

export const editTool: Tool = {
  definition: {
    name: 'edit_file',
    description: 'Edit a file by replacing a specific text pattern with new text. The old_text must match exactly.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The path to the file to edit (relative to workspace or absolute)',
        },
        oldText: {
          type: 'string',
          description: 'The exact text to find and replace',
        },
        newText: {
          type: 'string',
          description: 'The text to replace it with',
        },
      },
      required: ['path', 'oldText', 'newText'],
    },
  },

  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const { path, oldText, newText } = params as EditParams

    try {
      const fullPath = isAbsolute(path) ? path : resolve(context.workspaceDir, path)

      const content = await readFile(fullPath, 'utf-8')

      if (!content.includes(oldText)) {
        return {
          success: false,
          output: `Could not find the specified text in ${path}. Make sure the old_text matches exactly, including whitespace.`,
          suggestEscalation: true,
          escalationReason: 'Text not found - may need better context understanding',
        }
      }

      const occurrences = content.split(oldText).length - 1
      if (occurrences > 1) {
        return {
          success: false,
          output: `Found ${occurrences} occurrences of the text. Please provide more context to make the match unique.`,
        }
      }

      const newContent = content.replace(oldText, newText)
      await writeFile(fullPath, newContent, 'utf-8')

      return {
        success: true,
        output: `Successfully edited ${path}`,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        success: false,
        output: `Failed to edit file: ${message}`,
      }
    }
  },
}
