import { calculateCost, formatCost } from './costs'

export interface UsageStats {
  totalRequests: number
  localRequests: number
  remoteRequests: number
  escalations: number
  totalInputTokens: number
  totalOutputTokens: number
  localInputTokens: number
  localOutputTokens: number
  remoteInputTokens: number
  remoteOutputTokens: number
  totalCost: number
  savedCost: number  // Estimated savings from using local
}

export class StatsTracker {
  private stats: UsageStats = {
    totalRequests: 0,
    localRequests: 0,
    remoteRequests: 0,
    escalations: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    localInputTokens: 0,
    localOutputTokens: 0,
    remoteInputTokens: 0,
    remoteOutputTokens: 0,
    totalCost: 0,
    savedCost: 0,
  }

  private estimatedRemoteModel = 'claude-sonnet-4-20250514'

  recordRequest(
    provider: 'local' | 'remote',
    model: string,
    inputTokens: number,
    outputTokens: number,
    escalated: boolean
  ): void {
    this.stats.totalRequests++
    this.stats.totalInputTokens += inputTokens
    this.stats.totalOutputTokens += outputTokens

    if (provider === 'local') {
      this.stats.localRequests++
      this.stats.localInputTokens += inputTokens
      this.stats.localOutputTokens += outputTokens

      // Calculate what this would have cost with remote
      const wouldHaveCost = calculateCost(this.estimatedRemoteModel, inputTokens, outputTokens)
      this.stats.savedCost += wouldHaveCost
    } else {
      this.stats.remoteRequests++
      this.stats.remoteInputTokens += inputTokens
      this.stats.remoteOutputTokens += outputTokens

      const cost = calculateCost(model, inputTokens, outputTokens)
      this.stats.totalCost += cost
    }

    if (escalated) {
      this.stats.escalations++
    }
  }

  getStats(): UsageStats {
    return { ...this.stats }
  }

  formatSummary(): string {
    const s = this.stats
    const localPct = s.totalRequests > 0
      ? ((s.localRequests / s.totalRequests) * 100).toFixed(1)
      : '0'

    return `
Usage Statistics:
  Total Requests: ${s.totalRequests}
  Local: ${s.localRequests} (${localPct}%)
  Remote: ${s.remoteRequests}
  Escalations: ${s.escalations}

Tokens:
  Total: ${s.totalInputTokens} in / ${s.totalOutputTokens} out
  Local: ${s.localInputTokens} in / ${s.localOutputTokens} out
  Remote: ${s.remoteInputTokens} in / ${s.remoteOutputTokens} out

Cost:
  Actual: ${formatCost(s.totalCost)}
  Saved: ${formatCost(s.savedCost)} (estimated)
`.trim()
  }

  reset(): void {
    this.stats = {
      totalRequests: 0,
      localRequests: 0,
      remoteRequests: 0,
      escalations: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      localInputTokens: 0,
      localOutputTokens: 0,
      remoteInputTokens: 0,
      remoteOutputTokens: 0,
      totalCost: 0,
      savedCost: 0,
    }
  }
}

export function createStatsTracker(): StatsTracker {
  return new StatsTracker()
}
