export interface UsageStats {
  totalRequests: number
  totalInputTokens: number
  totalOutputTokens: number
}

export class StatsTracker {
  private stats: UsageStats = {
    totalRequests: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
  }

  recordRequest(_model: string, inputTokens: number, outputTokens: number): void {
    this.stats.totalRequests++
    this.stats.totalInputTokens += inputTokens
    this.stats.totalOutputTokens += outputTokens
  }

  getStats(): UsageStats {
    return { ...this.stats }
  }

  formatSummary(): string {
    const s = this.stats
    return `
Usage Statistics:
  Requests: ${s.totalRequests}
  Tokens:   ${s.totalInputTokens} in / ${s.totalOutputTokens} out
`.trim()
  }

  reset(): void {
    this.stats = {
      totalRequests: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    }
  }
}

export function createStatsTracker(): StatsTracker {
  return new StatsTracker()
}
