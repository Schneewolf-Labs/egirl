// Cost per million tokens for various models
export const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  // Anthropic
  'claude-opus-4-20250514': { input: 15.0, output: 75.0 },
  'claude-sonnet-4-20250514': { input: 3.0, output: 15.0 },
  'claude-3-5-sonnet-20241022': { input: 3.0, output: 15.0 },
  'claude-3-5-haiku-20241022': { input: 0.8, output: 4.0 },

  // OpenAI
  'gpt-4o': { input: 2.5, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4-turbo': { input: 10.0, output: 30.0 },

  // Local (free)
  'local': { input: 0, output: 0 },
}

export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const costs = MODEL_COSTS[model] ?? MODEL_COSTS['local'] ?? { input: 0, output: 0 }

  const inputCost = (inputTokens / 1_000_000) * costs.input
  const outputCost = (outputTokens / 1_000_000) * costs.output

  return inputCost + outputCost
}

export function formatCost(cost: number): string {
  if (cost === 0) return '$0.00'
  if (cost < 0.001) return `<$0.001`
  return `$${cost.toFixed(4)}`
}
