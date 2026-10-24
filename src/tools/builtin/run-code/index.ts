import { log } from '../../../util/logger'
import type { Tool, ToolResult } from '../../types'
import { LANGUAGES, type Language } from './languages'
import { resolveBinary, runSandboxed, type SandboxResult } from './sandbox'

export { LANGUAGES } from './languages'
export { sandboxUnavailable } from './sandbox'

export interface RunCodeConfig {
  /** Keys of LANGUAGES this instance offers, first one the default. */
  languages: string[]
  timeoutMs: number
  memoryMb: number
  /** Per-language interpreter path, overriding the PATH lookup. */
  binaries: Record<string, string>
}

const MAX_CODE = 20_000

interface Ready {
  name: string
  language: Language
  binaryPath: string
}

/**
 * The languages that can actually run: known to the table and with an interpreter on this
 * machine. Each one that can't is named once at startup rather than failing on first use.
 */
export function readyLanguages(config: RunCodeConfig): Ready[] {
  const ready: Ready[] = []
  for (const name of config.languages) {
    const language = LANGUAGES[name]
    if (!language) {
      log.warn(
        'tools',
        `[run_code] languages: unknown language "${name}" (known: ${Object.keys(LANGUAGES).join(', ')})`,
      )
      continue
    }
    const binaryPath = resolveBinary(config.binaries[name] ?? language.binary)
    if (!binaryPath) {
      log.warn(
        'tools',
        `[run_code] ${name}: interpreter "${config.binaries[name] ?? language.binary}" not found`,
      )
      continue
    }
    ready.push({ name, language, binaryPath })
  }
  return ready
}

export function formatResult(r: SandboxResult, timeoutMs: number): ToolResult {
  const parts: string[] = []
  if (r.stdout) parts.push(r.stdout.trimEnd())
  if (r.stderr) parts.push(`stderr:\n${r.stderr.trimEnd()}`)
  if (r.isTruncated) parts.push('[output truncated]')
  if (r.isTimedOut) {
    parts.push(
      `[killed: exceeded the ${timeoutMs / 1000}s time limit; use a faster algorithm or a smaller input]`,
    )
    return { success: false, output: parts.join('\n\n') }
  }
  if (r.exitCode !== 0) {
    parts.push(`[exit code ${r.exitCode ?? 'unknown'}]`)
    return { success: false, output: parts.join('\n\n') }
  }
  return {
    success: true,
    output: parts.join('\n\n') || '[no output; print the result you want to see]',
  }
}

/**
 * Run a short program in a sandbox. This is the instance's way to compute what `calculate`
 * can't (loops, enumeration, search, big integers, parsing): exact answers instead of a number
 * made up to look computed. No network and no host files, so it is safe where exec is off.
 */
export function createRunCodeTool(config: RunCodeConfig, ready: Ready[]): Tool {
  const byName = new Map(ready.map((r) => [r.name, r]))
  const names = ready.map((r) => r.name)
  const notes = ready.map((r) => `${r.name}: ${r.language.note}`).join('; ')

  return {
    definition: {
      name: 'run_code',
      description:
        'Run a short program and return what it prints. Use it whenever an exact answer needs ' +
        'real computation that calculate cannot do: loops, counting or enumerating cases, ' +
        'searching, primes and number theory, big integers, simulations, parsing text. Write the ' +
        'program, print the result, and answer from the output; never state a computed number ' +
        `you did not get from a tool. Languages: ${notes}. Sandboxed: no network, no files ` +
        `outside the working directory, ${config.timeoutMs / 1000}s time limit, ` +
        `${config.memoryMb} MB memory.`,
      parameters: {
        type: 'object',
        properties: {
          language: {
            type: 'string',
            enum: names,
            description: `Language of the program (default ${names[0]})`,
          },
          code: { type: 'string', description: 'The complete program. Print what you want back.' },
        },
        required: ['code'],
      },
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const code = typeof params.code === 'string' ? params.code : ''
      if (!code.trim()) return { success: false, output: 'code is required' }
      if (code.length > MAX_CODE) {
        return { success: false, output: `program is too long (max ${MAX_CODE} characters)` }
      }
      const name =
        typeof params.language === 'string' && params.language ? params.language : names[0]
      const lang = name ? byName.get(name) : undefined
      if (!lang)
        return {
          success: false,
          output: `unknown language "${name}" (available: ${names.join(', ')})`,
        }

      const result = await runSandboxed({
        binaryPath: lang.binaryPath,
        args: lang.language.args,
        extension: lang.language.extension,
        readPaths: lang.language.readPaths,
        code,
        timeoutMs: config.timeoutMs,
        memoryMb: config.memoryMb,
      })
      return formatResult(result, config.timeoutMs)
    },
  }
}
