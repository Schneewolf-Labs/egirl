/** Default timeout: 5 minutes */
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

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
