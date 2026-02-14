import type { ChatMessage } from '../providers/types'
import { getTextContent } from '../providers/types'

export interface HeuristicResult {
  shouldEscalate: boolean
  reason?: string
  confidence: number
}

// Keywords that suggest code generation or complex reasoning
const CODE_KEYWORDS = [
  'write code',
  'implement',
  'create a function',
  'build a',
  'develop',
  'refactor',
  'debug',
  'fix this code',
  'optimize',
  'code review',
  'write a script',
  'create a class',
  'write tests',
  'unit test',
]

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

  // Check for code-related keywords
  const hasCodeKeywords = CODE_KEYWORDS.some((k) => content.includes(k))
  if (hasCodeKeywords) {
    return { shouldEscalate: true, reason: 'code_generation', confidence: 0.8 }
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
