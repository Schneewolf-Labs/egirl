/**
 * For backends that take a text prompt only: name the image files in the task so the agent
 * opens them itself (Claude Code's Read tool renders images).
 */
export function withImagePaths(task: string, images: string[] | undefined): string {
  if (!images?.length) return task
  const list = images.map((p) => `- ${p}`).join('\n')
  return `${task}\n\nImages the user attached (open them to see what they show):\n${list}`
}

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
