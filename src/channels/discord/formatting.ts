import type { ToolCall } from '../../providers/types'

export function formatToolCallsMarkdown(calls: ToolCall[]): string {
  const lines = calls.map((call) => {
    const args = Object.entries(call.arguments)
    if (args.length === 0) return `${call.name}()`
    if (args.length === 1) {
      const [key, val] = args[0]!
      const valStr = typeof val === 'string' ? val : JSON.stringify(val)
      if (valStr.length < 60) return `${call.name}(${key}: ${valStr})`
    }
    return `${call.name}(${JSON.stringify(call.arguments)})`
  })
  return lines.join('\n')
}

export function truncateResult(output: string, maxLen: number): string {
  const trimmed = output.trim()
  if (!trimmed) return ''
  if (trimmed.length <= maxLen) return trimmed
  return `${trimmed.substring(0, maxLen)}...`
}

export function splitMessage(content: string, maxLength: number): string[] {
  const chunks: string[] = []
  let remaining = content

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining)
      break
    }

    // Try to split at a newline
    let splitIndex = remaining.lastIndexOf('\n', maxLength)
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      // Try to split at a space
      splitIndex = remaining.lastIndexOf(' ', maxLength)
    }
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      // Hard split
      splitIndex = maxLength
    }

    chunks.push(remaining.slice(0, splitIndex))
    remaining = remaining.slice(splitIndex).trimStart()
  }

  return chunks
}
