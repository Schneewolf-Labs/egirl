import type { ChatMessage } from '../providers/types'
import { getTextContent } from '../providers/types'

export interface HeuristicResult {
  shouldEscalate: boolean
  reason?: string
  confidence: number
}

// Multi-word phrases that unambiguously indicate code generation — single match sufficient
export const STRONG_CODE_INDICATORS = [
  'write code',
  'create a function',
  'fix this code',
  'write a script',
  'create a class',
  'write tests',
  'unit test',
  'code review',
]

// Single-word signals that appear in non-code contexts — require compound signal
export const WEAK_CODE_SIGNALS = [
  'implement',
  'build a',
  'develop',
  'refactor',
  'debug',
  'optimize',
]

// Combined list used by estimateComplexity
const CODE_KEYWORDS = [...STRONG_CODE_INDICATORS, ...WEAK_CODE_SIGNALS]

const REASONING_KEYWORDS = [
  'explain in detail',
  'analyze',
  'compare and contrast',
  'evaluate',
  'what are the implications',
  'why does',
  'how does this work',
  'step by step',
  'reasoning',
  'logic behind',
]

const SIMPLE_KEYWORDS = [
  'hi',
  'hello',
  'hey',
  'thanks',
  'thank you',
  'bye',
  'goodbye',
  'what time',
  "what's the weather",
  'how are you',
]

// Patterns that indicate tool use
const TOOL_PATTERNS = [
  /read\s+(?:the\s+)?file/i,
  /write\s+(?:to\s+)?(?:the\s+)?file/i,
  /execute\s+(?:the\s+)?command/i,
  /run\s+(?:the\s+)?(?:command|script)/i,
  /search\s+(?:for|in)/i,
  /find\s+(?:files?|in)/i,
  /list\s+(?:files?|directories?)/i,
  /remember\s+(?:that|this)/i,
  /recall\s+(?:what|when)/i,
]

export function analyzeMessageHeuristics(messages: ChatMessage[]): HeuristicResult {
  const lastMessage = messages[messages.length - 1]
  if (!lastMessage || lastMessage.role !== 'user') {
    return { shouldEscalate: false, confidence: 0.5 }
  }

  const content = getTextContent(lastMessage.content).toLowerCase()
  const wordCount = content.split(/\s+/).length

  // Very short messages are usually simple
  if (wordCount <= 3) {
    const isGreeting = SIMPLE_KEYWORDS.some((k) => content.includes(k))
    if (isGreeting) {
      return { shouldEscalate: false, reason: 'simple_greeting', confidence: 0.95 }
    }
  }

  // Check for strong code indicators — single match is sufficient
  const hasStrongCode = STRONG_CODE_INDICATORS.some((k) => content.includes(k))
  if (hasStrongCode) {
    return { shouldEscalate: true, reason: 'code_generation', confidence: 0.8 }
  }

  // Check for weak code signals — require compound signal (keyword + length)
  const hasWeakCode = WEAK_CODE_SIGNALS.some((k) => content.includes(k))
  if (hasWeakCode && wordCount > 5) {
    return { shouldEscalate: true, reason: 'code_generation', confidence: 0.75 }
  }

  // Check for complex reasoning keywords
  const hasReasoningKeywords = REASONING_KEYWORDS.some((k) => content.includes(k))
  if (hasReasoningKeywords && wordCount > 10) {
    return { shouldEscalate: true, reason: 'complex_reasoning', confidence: 0.7 }
  }

  // Check for tool use patterns
  const hasToolPatterns = TOOL_PATTERNS.some((p) => p.test(content))
  if (hasToolPatterns) {
    // Tool use can be local for simple operations
    return { shouldEscalate: false, reason: 'tool_use', confidence: 0.6 }
  }

  // Code blocks in the message suggest code discussion
  if (content.includes('```')) {
    return { shouldEscalate: true, reason: 'code_discussion', confidence: 0.75 }
  }

  // Long messages might need more capability
  if (wordCount > 100) {
    return { shouldEscalate: true, reason: 'long_context', confidence: 0.6 }
  }

  // Default: let local handle it
  return { shouldEscalate: false, confidence: 0.5 }
}

export function estimateComplexity(content: string): 'trivial' | 'simple' | 'moderate' | 'complex' {
  const wordCount = content.split(/\s+/).length
  const hasCode = content.includes('```')
  const hasCodeKeywords = CODE_KEYWORDS.some((k) => content.toLowerCase().includes(k))

  if (wordCount <= 5 && !hasCode && !hasCodeKeywords) return 'trivial'
  if (wordCount <= 20 && !hasCode && !hasCodeKeywords) return 'simple'
  if (wordCount <= 100 || hasCode) return 'moderate'
  return 'complex'
}
