/** Split a reply into pieces no longer than a transport's message cap, preferring line then word boundaries. */
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
