/**
 * Per-conversation display verbosity: how much of the machinery behind a turn shows up in the
 * reply. Two independent switches — the compact tool-call lines, and her reasoning block — set
 * by /tools, /reasoning, /verbose and /quiet (session/commands.ts) and read by the spine when it
 * composes a reply (channels/spine.ts).
 *
 * This is display only; it changes nothing about how she thinks or which tools she uses. It lives
 * here, not on the Operator or the terminal-only SessionController, so every surface can carry it
 * the same way — a chat channel keeps one store per conversation, and a future app layer does the
 * same. A surface that provides no store gets DEFAULT_VERBOSITY, which is today's behavior.
 */

export interface Verbosity {
  /** Show the compact tool-call lines before a reply. */
  tools: boolean
  /** Show her reasoning (the thinking block) before a reply. */
  thinking: boolean
}

/** Tool-call lines on, reasoning off — the long-standing default for chat surfaces. */
export const DEFAULT_VERBOSITY: Verbosity = { tools: true, thinking: false }

export interface VerbosityStore {
  get(): Verbosity
  /** Apply a partial change and return the new state. */
  set(patch: Partial<Verbosity>): Verbosity
}

/** A store backed by one mutable object. The caller keeps one per conversation. */
export function makeVerbosityStore(initial: Partial<Verbosity> = {}): VerbosityStore {
  const state: Verbosity = { ...DEFAULT_VERBOSITY, ...initial }
  return {
    get: () => ({ ...state }),
    set: (patch) => {
      Object.assign(state, patch)
      return { ...state }
    },
  }
}
