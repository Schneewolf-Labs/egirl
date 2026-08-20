/**
 * Per-model-family floors for the stale-stream timeout.
 *
 * A reasoning model spends the front of every turn thinking, and on a hard question that
 * phase alone outlasts a chat-model stale timeout -- the detector kills the stream while the
 * model is mid-thought and the abort surfaces as "Stream stale ... aborting generation" on a
 * server that was never stuck. Zero hit exactly this on Qwen3.8 (300s of reasoning, healthy
 * slot). Counting reasoning deltas as activity fixed the streaming case; this floor covers
 * the rest of the silent window -- prefill on a large cold context emits nothing at all.
 *
 * Ported from hermes-agent's reasoning_timeouts.py, which carries the measured multi-minute
 * thinking phases of every hosted reasoning family. Only the families that run on llama.cpp
 * in this house are kept, and matching is adapted to local GGUF naming: model names here are
 * freeform ("wichtel-qwen3.6-27b-q8_0"), so a slug matches as a prefix of any '-'/'_'/'/'
 * separated token rather than anchored at the start of the name.
 *
 * The floor is a FLOOR: applied as max(configured, floor), it can only lengthen the wait on
 * a genuinely hung server, never shorten a timeout someone chose deliberately.
 */

/** (token-prefix slug, floor in ms). First match wins; order by specificity. */
const FLOORS: ReadonlyArray<readonly [string, number]> = [
  // QwQ thinks longer than the mainline Qwen3 family.
  ['qwq', 300_000],
  // Covers qwen3, qwen3.5, qwen3.6, qwen3.8 -- every thinking-variant token shape --
  // via prefix match. Instruct variants get the floor too; hermes accepts the same
  // trade-off, because matching only "-thinking" names breaks on the next rename.
  ['qwen3', 180_000],
  // R1 distills keep the deep-reasoning phase of their teacher.
  ['deepseek', 600_000],
  ['r1', 600_000],
  // House models built on reasoning pretrains, whose names carry no qwen3 token.
  ['hemlock', 300_000],
  ['schneewolf', 180_000],
]

/**
 * Floor for `model`, or 0 when the name matches no known reasoning family.
 *
 * Matching: lowercase the name, split into tokens on separators, and test each slug as a
 * token prefix -- "qwen3" matches the "qwen3.8" token in "huihui-qwen3.8-27b-abliterated"
 * but not "qwen2.5" or an unrelated "en3" substring.
 */
export function reasoningStaleFloorMs(model: string): number {
  const tokens = model.toLowerCase().split(/[-_/\s]+/)
  for (const [slug, floor] of FLOORS) {
    if (tokens.some((t) => t.startsWith(slug))) return floor
  }
  return 0
}

/** max(configured, family floor) -- never lower than what was asked for. */
export function withReasoningFloor(model: string, configuredMs: number): number {
  return Math.max(configuredMs, reasoningStaleFloorMs(model))
}
