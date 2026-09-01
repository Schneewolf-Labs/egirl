/** Default timeout: 5 minutes */
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Default timeout for a backgrounded delegation: 30 minutes.
 *
 * The foreground ceiling is set by how long the operator can sit blocked on a tool call. A
 * background run is not blocking anything, so the ceiling is only there to stop a wedged
 * delegate from living forever, and cutting a working refactor off at five minutes wastes it.
 */
export const DEFAULT_BACKGROUND_TIMEOUT_MS = 30 * 60 * 1000

const ESC = String.fromCharCode(27)
const ANSI_OSC_RE = new RegExp(`${ESC}\\][^\\x07]*(?:\\x07|${ESC}\\\\)`, 'g')
const ANSI_CSI_RE = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, 'g')
const ANSI_MODE_RE = new RegExp(`${ESC}[>=<][0-?]*`, 'g')
const ANSI_CHARSET_RE = new RegExp(`${ESC}[()#][0-9A-Za-z]`, 'g')
const ANSI_SINGLE_RE = new RegExp(`${ESC}.`, 'g')

export function stripAnsi(value: string): string {
  return value
    .replace(ANSI_OSC_RE, '')
    .replace(ANSI_CSI_RE, '')
    .replace(ANSI_MODE_RE, '')
    .replace(ANSI_CHARSET_RE, '')
    .replace(ANSI_SINGLE_RE, '')
}
