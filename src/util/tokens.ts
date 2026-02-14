// Simple token estimation utilities
// These are rough approximations - actual token counts depend on the model's tokenizer

export function estimateTokens(text: string): number {
  // Rough estimate: ~4 characters per token for English text
  // This is a simplified approximation
  return Math.ceil(text.length / 4)
}

export function estimateMessagesTokens(messages: Array<{ content: string; role: string }>): number {
  let total = 0

  for (const msg of messages) {
    // Add tokens for role and content
    total += estimateTokens(msg.content)
    total += 4 // Overhead for message structure
  }

  return total
}

export function truncateToTokenLimit(text: string, maxTokens: number): string {
  const estimatedChars = maxTokens * 4
  if (text.length <= estimatedChars) return text

  return `${text.slice(0, estimatedChars - 3)}...`
}
