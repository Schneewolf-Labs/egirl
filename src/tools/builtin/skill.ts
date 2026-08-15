import type { Skill } from '../../skills/types'
import type { Tool, ToolResult } from '../types'

/**
 * Load a skill's instructions on demand.
 *
 * The system prompt used to carry every skill's full body. With two bundled skills that is
 * ~2.5KB of a 12.5KB stable prefix and unremarkable; it stops being unremarkable the moment
 * skills are written rather than shipped, because then success looks like more skills. Thirty of
 * them is ~40KB spent before the conversation starts, on instructions irrelevant to almost every
 * turn.
 *
 * So the prompt carries names and descriptions, and this returns the body when one is actually
 * needed. The cost is one round trip on the turns that use a skill; the saving is on every turn
 * that does not.
 *
 * The body arrives as a tool result, which lives in the message history rather than the system
 * prompt — so loading a skill mid-conversation does not invalidate the cached stable prefix.
 */
export function createSkillReadTool(skills: Skill[]): Tool {
  return {
    definition: {
      name: 'skill_read',
      description:
        'Load the full instructions for one of your available skills. Call this before acting ' +
        'on a skill — the system prompt lists only what each skill is for, not how to do it.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'The skill name exactly as listed in Available Skills',
          },
        },
        required: ['name'],
      },
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const requested = String(params.name ?? '').trim()
      if (!requested) {
        return { success: false, output: 'No skill name given.' }
      }

      const wanted = requested.toLowerCase()
      const skill =
        skills.find((s) => s.name.toLowerCase() === wanted) ??
        // Models routinely pass a slug for a display name ("code-review" for "Code Review").
        skills.find((s) => s.name.toLowerCase().replace(/[\s_]+/g, '-') === wanted)

      if (!skill) {
        const available = skills.map((s) => s.name).join(', ') || '(none loaded)'
        return {
          success: false,
          output: `No skill named "${requested}". Available: ${available}`,
        }
      }

      return {
        success: true,
        output: `# ${skill.name}\n\n${skill.content}`,
      }
    },
  }
}
