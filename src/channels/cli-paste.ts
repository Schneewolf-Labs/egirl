/**
 * A multi-line paste, held until enter.
 *
 * With bracketed paste on, the terminal marks where pasted text begins and ends. Without it a
 * pasted traceback arrived as a dozen enters: a dozen turns, or a dozen queued messages. Lines
 * that end inside a paste are held instead; the live line keeps editing the last one, and the
 * next enter sends them all as one message.
 */

export interface PasteBuffer {
  start(): void
  end(): void
  /**
   * A line readline finished. Undefined: it was held (it ended inside a paste). Otherwise the
   * text to send: any held lines with this one after them.
   */
  take(line: string): string | undefined
  /** How many lines are held. */
  held(): number
  clear(): void
}

/** Turns bracketed paste on in the terminal, and off again. */
export const PASTE_ON = '\x1b[?2004h'
export const PASTE_OFF = '\x1b[?2004l'

export function createPasteBuffer(): PasteBuffer {
  let pasting = false
  let lines: string[] = []
  return {
    start() {
      pasting = true
    },
    end() {
      pasting = false
    },
    take(line) {
      if (pasting) {
        lines.push(line)
        return undefined
      }
      if (lines.length === 0) return line
      const text = [...lines, line].join('\n')
      lines = []
      return text
    },
    held: () => lines.length,
    clear() {
      lines = []
    },
  }
}
