/**
 * What the terminal can complete: slash commands, their arguments, and task names.
 *
 * One table for the CLI's commands, used by Tab completion, the inline suggestion and the
 * startup banner, so the three cannot drift apart. It is a constant, not a registry: a command
 * added to the CLI is added here by hand, like every other hardcoded thing in this codebase.
 */

import { THINKING_LEVELS } from '../session/commands'

export interface CommandSpec {
  name: string
  /** Fixed argument words. `tasks` is special-cased: its targets are live task names. */
  args?: readonly string[]
}

export const CLI_COMMANDS: readonly CommandSpec[] = [
  { name: 'help' },
  { name: 'think', args: ['on', 'default', ...THINKING_LEVELS] },
  { name: 'plan' },
  { name: 'learn' },
  { name: 'status' },
  { name: 'context' },
  { name: 'compact' },
  { name: 'tasks', args: ['all', 'run', 'pause', 'resume'] },
  { name: 'continue' },
  { name: 'maxturns', args: ['10', '25', '50', '100'] },
  { name: 'auto' },
  { name: 'stats', args: ['on', 'off'] },
  { name: 'markdown', args: ['on', 'off'] },
  { name: 'reasoning' },
  { name: 'verbose' },
  { name: 'quiet' },
  { name: 'queue' },
  { name: 'clear' },
  { name: 'settings' },
  { name: 'wipe' },
  { name: 'prompt' },
  { name: 'debug' },
  { name: 'exit' },
]

export interface Completion {
  /** The word being completed: the text before the cursor back to the last space. */
  token: string
  /** Every full word that would replace it, in table order. */
  candidates: string[]
}

/**
 * Complete the last word of `line` (the text before the cursor). Only slash input completes:
 * a plain message is prose, and suggesting words into it would be noise.
 */
export function complete(
  line: string,
  taskNames: () => string[] = () => [],
  skillCommands: () => string[] = () => [],
): Completion {
  const none = { token: '', candidates: [] }
  if (!line.startsWith('/')) return none
  const words = line.split(' ')
  const token = words.at(-1) ?? ''
  if (words.length === 1) {
    const names = [...CLI_COMMANDS.map((c) => `/${c.name}`), ...skillCommands().map((n) => `/${n}`)]
    return { token, candidates: names.filter((n) => n.startsWith(token)) }
  }
  const spec = CLI_COMMANDS.find((c) => `/${c.name}` === words[0])
  if (!spec) return none
  let options: readonly string[] = []
  if (words.length === 2) options = spec.args ?? []
  // `/tasks run <name>`: the third word is a task.
  const verb = words[1] ?? ''
  if (spec.name === 'tasks' && ['run', 'pause', 'resume'].includes(verb) && words.length === 3) {
    options = taskNames()
  }
  // `/tasks <name>` shows one task: offer names alongside the verbs.
  if (spec.name === 'tasks' && words.length === 2) options = [...options, ...taskNames()]
  return { token, candidates: options.filter((o) => o.startsWith(token) && o !== token) }
}

/** The text a unique completion would add, or undefined when there is not exactly one. */
export function uniqueSuffix(c: Completion): string | undefined {
  if (c.candidates.length !== 1) return undefined
  const [only] = c.candidates as [string]
  return only.slice(c.token.length)
}

/**
 * The dim text drawn after the cursor, and what → would accept: the empty line's suggestion,
 * the rest of a unique completion, or the choices when there are several (not acceptable).
 */
export function ghostFor(
  line: string,
  suggestion: string | undefined,
  completer: ((line: string) => Completion) | undefined,
): { text: string; accept?: string } | undefined {
  if (line === '') return suggestion ? { text: suggestion, accept: suggestion } : undefined
  const c = completer?.(line)
  if (!c || c.candidates.length === 0) return undefined
  const suffix = uniqueSuffix(c)
  if (suffix) return { text: suffix, accept: suffix }
  if (c.candidates.length < 2) return undefined
  return { text: `  ${c.candidates.join(' ')}` }
}
