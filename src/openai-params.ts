import type { SamplingParams } from './providers/types'

/**
 * Sampling fields of an OpenAI chat-completions request, checked and mapped onto one run.
 *
 * A request here is a whole agent run: tool-call turns, then an answer. Two fields need a rule
 * for that, because OpenAI defines them for a single generation:
 *
 * - `max_tokens` (or `max_completion_tokens`) caps each generation of the run, which is what
 *   llama.cpp does with it. It is not a budget shared across turns: a cap split across turns
 *   would leave the answer whatever the tool calls did not use. A cap too small for a tool
 *   call (one call is ~50-150 tokens, more with thinking on) cuts that call off; the loop's
 *   usual recovery then asks for it again. Continuation stitching is off for the run, so the
 *   answer the client sees never runs past the cap, and an answer cut there finishes with
 *   `finish_reason: "length"`.
 * - `stop` applies to the answer, not to the model calls. llama.cpp would stop every turn at
 *   the sequence, tool calls included (a stop of "\n" ends a call before its arguments). The
 *   answer is cut at the first stop sequence after it is generated; the tokens after it are
 *   still spent.
 */

export interface RequestParams {
  sampling?: SamplingParams
  stop?: string[]
}

type Check = (v: number) => boolean

const RANGES: Record<Exclude<keyof SamplingParams, 'max_tokens'>, [Check, string]> = {
  temperature: [(v) => v >= 0 && v <= 2, 'a number from 0 to 2'],
  top_p: [(v) => v >= 0 && v <= 1, 'a number from 0 to 1'],
  seed: [Number.isInteger, 'an integer'],
  presence_penalty: [(v) => v >= -2 && v <= 2, 'a number from -2 to 2'],
  frequency_penalty: [(v) => v >= -2 && v <= 2, 'a number from -2 to 2'],
}

/** `null` is how clients say "unset"; treat it like a missing field. */
function present(v: unknown): boolean {
  return v !== undefined && v !== null
}

function parseMaxTokens(body: Record<string, unknown>): number | string | undefined {
  // max_completion_tokens is OpenAI's current name; max_tokens is the older alias.
  const key = present(body.max_completion_tokens) ? 'max_completion_tokens' : 'max_tokens'
  const v = body[key]
  if (!present(v)) return undefined
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    return `${key} must be a positive integer`
  }
  return v
}

function parseStop(v: unknown): string[] | string | undefined {
  if (!present(v)) return undefined
  const list = typeof v === 'string' ? [v] : v
  if (
    !Array.isArray(list) ||
    list.length > 4 ||
    !list.every((s) => typeof s === 'string' && s.length > 0)
  ) {
    return 'stop must be a non-empty string or an array of up to 4 non-empty strings'
  }
  return list.length > 0 ? list : undefined
}

/** The request's sampling and stop fields, or an error message for a 400. */
export function parseRequestParams(body: Record<string, unknown>): RequestParams | string {
  const sampling: SamplingParams = {}
  for (const [key, [ok, what]] of Object.entries(RANGES)) {
    const v = body[key]
    if (!present(v)) continue
    if (typeof v !== 'number' || !Number.isFinite(v) || !ok(v)) return `${key} must be ${what}`
    sampling[key as keyof typeof RANGES] = v
  }
  const maxTokens = parseMaxTokens(body)
  if (typeof maxTokens === 'string') return maxTokens
  if (maxTokens !== undefined) sampling.max_tokens = maxTokens
  const stop = parseStop(body.stop)
  if (typeof stop === 'string') return stop

  return {
    ...(Object.keys(sampling).length > 0 && { sampling }),
    ...(stop && { stop }),
  }
}

/** Cut the answer at the earliest stop sequence. The sequence itself is not returned. */
export function applyStop(text: string, stop: string[] | undefined): string {
  if (!stop) return text
  let cut = text.length
  for (const s of stop) {
    const i = text.indexOf(s)
    if (i !== -1 && i < cut) cut = i
  }
  return text.slice(0, cut)
}
