/**
 * Keep the keyboard alive while a turn is running.
 *
 * readline hands input to whoever called `question()`, and during a turn nobody has. Keystrokes
 * therefore sit in a buffer until the prompt returns and then arrive all at once -- which is why
 * typing during a long run feels like the terminal has frozen, and why there is currently no way
 * to interrupt one.
 *
 * This takes over stdin for the duration: Escape aborts, typed lines go to the queue (a slash
 * command is answered at once instead), and Ctrl-C still reaches the process. It is deliberately separate from the channel so the raw-mode
 * bookkeeping -- which is easy to get wrong and leaves a terminal unusable when it is -- lives in
 * one place with one exit path.
 */

import { isCommand } from '../session/commands'
import type { SessionController } from '../session/controller'

export interface LiveInputHandle {
  /** Restore the terminal. Safe to call more than once. */
  stop(): void
}

/**
 * Capture keys for the duration of a run.
 *
 * `onQueued` fires when a line is accepted so the renderer can acknowledge it -- without that,
 * typing during a turn looks identical to typing into a dead terminal.
 */
export function captureDuringRun(
  session: SessionController,
  hooks: {
    onInterrupt(): void
    onQueued(text: string): void
    /** A slash command typed mid-run is answered now, not queued behind the turn. */
    onCommand?(text: string): void
  },
): LiveInputHandle {
  const stdin = process.stdin
  const wasRaw = stdin.isRaw ?? false
  let buffer = ''
  let stopped = false

  // Without a TTY there is nothing to capture: piped input has no keystrokes and setRawMode does
  // not exist. Returning a no-op keeps `egirl cli < script.txt` working.
  if (!stdin.isTTY) {
    return { stop() {} }
  }

  const onData = (chunk: Buffer): void => {
    const s = chunk.toString('utf8')

    for (const ch of s) {
      // Ctrl-C: pass through as a real SIGINT rather than swallowing it. A terminal where Ctrl-C
      // does nothing is worse than one with no interrupt at all.
      if (ch === '\u0003') {
        stop()
        process.kill(process.pid, 'SIGINT')
        return
      }

      // Escape aborts the turn. Checked before the printable branch so it never lands in the
      // buffer, and ignored when nothing is running so a stray press is not reported as a stop.
      if (ch === '\u001b') {
        if (session.interrupt()) hooks.onInterrupt()
        continue
      }

      if (ch === '\r' || ch === '\n') {
        const text = buffer.trim()
        buffer = ''
        if (text && hooks.onCommand && isCommand(text)) {
          hooks.onCommand(text)
        } else if (text) {
          session.enqueue(text)
          hooks.onQueued(text)
        }
        continue
      }

      if (ch === '\u007f' || ch === '\b') {
        buffer = buffer.slice(0, -1)
        continue
      }

      // Ignore the rest of the escape sequences an arrow key or a mouse produces; they would
      // otherwise arrive as stray letters in the queued text.
      if (ch < ' ') continue

      buffer += ch
    }
  }

  const stop = (): void => {
    if (stopped) return
    stopped = true
    stdin.off('data', onData)
    // Only surrender raw mode if this call established it. A caller that was already in raw mode
    // for its own reasons should get it back exactly as it was.
    if (!wasRaw && stdin.isTTY) stdin.setRawMode(false)
  }

  if (!wasRaw) stdin.setRawMode(true)
  stdin.resume()
  stdin.on('data', onData)

  return { stop }
}
