import type { ChatResponse } from '../providers/types'

export interface EscalationDecision {
  shouldEscalate: boolean
  reason?: string
  confidence: number
}

// Patterns in responses that suggest the local model is struggling
const UNCERTAINTY_PATTERNS = [
  /i('m| am) not sure/i,
  /i don't know/i,
  /i cannot/i,
  /i('m| am) unable to/i,
  /this is beyond/i,
  /i would need more/i,
  /this requires/i,
  /i('m| am) having trouble/i,
  /let me think/i,
  /this is complex/i,
]

const ERROR_PATTERNS = [
  /error:/i,
  /failed to/i,
  /cannot parse/i,
  /invalid/i,
  /syntax error/i,
]

export function analyzeResponseForEscalation(
  response: ChatResponse,
  threshold: number
): EscalationDecision {
  // If confidence is provided and below threshold, escalate
  if (response.confidence !== undefined && response.confidence < threshold) {
    return {
      shouldEscalate: true,
      reason: 'low_confidence',
      confidence: response.confidence,
    }
  }

  const content = response.content

  // Strip code blocks before checking patterns — we only care about
  // the model's own words, not code it's quoting
  const prose = content.replace(/```[\s\S]*?```/g, '').replace(/`[^`]+`/g, '')

  // Check for uncertainty patterns in the model's prose
  const hasUncertainty = UNCERTAINTY_PATTERNS.some(p => p.test(prose))
  if (hasUncertainty) {
    return {
      shouldEscalate: true,
      reason: 'uncertainty_detected',
      confidence: 0.3,
    }
  }

  // Check for error patterns in the model's prose (not in quoted code)
  const hasErrors = ERROR_PATTERNS.some(p => p.test(prose))
  if (hasErrors) {
    return {
      shouldEscalate: true,
      reason: 'potential_code_errors',
      confidence: 0.4,
    }
  }

  // Very short response to a complex question might indicate struggle
  if (content.length < 50 && !response.tool_calls) {
    return {
      shouldEscalate: true,
      reason: 'insufficient_response',
      confidence: 0.5,
    }
  }

  return {
    shouldEscalate: false,
    confidence: response.confidence ?? 0.7,
  }
}

export function shouldRetryWithRemote(
  localResponse: ChatResponse,
  threshold: number
): boolean {
  const decision = analyzeResponseForEscalation(localResponse, threshold)
  return decision.shouldEscalate
}
