import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { Tool, ToolResult } from '../types'

/**
 * The consult tool — a read-only second opinion from a bigger-context model.
 *
 * The consultant never runs tools; it receives one packaged request (question + attached
 * files + optional pasted context) and answers from that. This is deliberate: a model can be
 * bad at our tool dialects and still be an excellent reviewer, and a consultant with a 384k
 * window can hold entire notes files that would never fit in the operator's context. The
 * operator stays the operator — consulting is escalation to a tool, not to another driver.
 */

export interface ConsultantEntry {
  name: string
  endpoint: string
  model: string
  contextLength: number
  maxTokens: number
  timeoutMs: number
  temperature?: number
  apiKey?: string
}

/** Rough chars-per-token for budgeting packaged material. Conservative to avoid overflow. */
const CHARS_PER_TOKEN = 3

/** Reserved for the system prompt, question, framing, and template overhead. */
const OVERHEAD_TOKENS = 2000

const CONSULTANT_SYSTEM_PROMPT = `You are a senior technical consultant. Another AI agent working on a long-running task is asking you for a second opinion. You cannot run tools or ask follow-up questions — answer fully from the material provided.

Be specific and concrete: point out actual errors, missed leads, inconsistencies, and better approaches, citing the provided material (file names, sections, values) rather than offering generalities. If the material cannot support a confident answer, say exactly what is missing. Structure your answer so the most important observation comes first.`

/** Keep head and tail when a file exceeds its share — for notes files both ends matter. */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const head = Math.floor(maxChars * 0.4)
  const tail = maxChars - head
  return `${text.slice(0, head)}\n\n[... middle truncated (${text.length - maxChars} chars) ...]\n\n${text.slice(text.length - tail)}`
}

/**
 * Assemble the consultation request body within a character budget. Files split the budget
 * left over after the pasted context; both are middle-truncated rather than dropped.
 */
export function packConsultation(
  question: string,
  files: Array<{ path: string; content: string }>,
  context: string | undefined,
  charBudget: number,
): string {
  const parts: string[] = []

  let remaining = charBudget
  if (context?.trim()) {
    const contextCap = Math.min(context.length, Math.floor(charBudget * 0.3))
    parts.push(`## Context from the asking agent\n\n${truncateMiddle(context.trim(), contextCap)}`)
    remaining -= Math.min(context.length, contextCap)
  }

  if (files.length > 0) {
    const share = Math.max(1000, Math.floor(remaining / files.length))
    for (const f of files) {
      parts.push(`## File: ${f.path}\n\n${truncateMiddle(f.content, share)}`)
    }
  }

  parts.push(`## Question\n\n${question.trim()}`)
  return parts.join('\n\n---\n\n')
}

interface ConsultResponse {
  choices?: Array<{
    message?: { content?: string | null; reasoning?: string; reasoning_content?: string }
  }>
  error?: { message?: string }
}

export function createConsultTool(consultants: ConsultantEntry[], workspaceDir: string): Tool {
  const names = consultants.map((c) => c.name).join(', ')
  const single = consultants.length === 1 ? consultants[0] : undefined

  return {
    definition: {
      name: 'consult',
      description:
        'Ask a consultant model for a read-only second opinion. The consultant has a much larger context window than you — attach whole files (your notes, state, source) rather than excerpts. ' +
        'It cannot run tools or see your conversation; everything it needs must be in the question, the attached files, or the context field. ' +
        'Use it when you are stuck, suspect you are missing something, or want your plan or findings critiqued before committing to a direction. ' +
        `Configured consultants: ${names}.`,
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description:
              'What you want reviewed or answered. Self-contained and specific — state what you have tried and what kind of answer helps.',
          },
          files: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Paths of files to attach in full (resolved against your workspace). Attach generously — the consultant has room.',
          },
          context: {
            type: 'string',
            description:
              'Optional free-form context to include: recent findings, error output, transcript excerpts.',
          },
          consultant: {
            type: 'string',
            description: `Which consultant to ask (one of: ${names}). Optional when only one is configured.`,
          },
        },
        required: ['question'],
      },
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const question = params.question as string | undefined
      if (!question?.trim()) return { success: false, output: 'question is required' }

      const chosenName = params.consultant as string | undefined
      const consultant = chosenName
        ? consultants.find((c) => c.name.toLowerCase() === chosenName.toLowerCase())
        : single
      if (!consultant) {
        return {
          success: false,
          output: chosenName
            ? `Unknown consultant "${chosenName}". Configured: ${names}`
            : `Multiple consultants configured — pass one of: ${names}`,
        }
      }

      // Read attachments; a missing file is reported, not fatal — the consultant is told.
      const filePaths = Array.isArray(params.files) ? (params.files as string[]) : []
      const files: Array<{ path: string; content: string }> = []
      for (const p of filePaths) {
        const abs = isAbsolute(p) ? p : resolve(workspaceDir, p)
        try {
          files.push({ path: p, content: readFileSync(abs, 'utf8') })
        } catch {
          files.push({ path: p, content: `[file could not be read: ${abs}]` })
        }
      }

      const charBudget = Math.max(
        4000,
        (consultant.contextLength - consultant.maxTokens - OVERHEAD_TOKENS) * CHARS_PER_TOKEN,
      )
      const body = packConsultation(
        question,
        files,
        params.context as string | undefined,
        charBudget,
      )

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), consultant.timeoutMs)
      try {
        // Bun's fetch carries its own default 300s timeout that fires BEFORE our
        // AbortController budget — three real consults died at ~5min while the model was
        // still legitimately thinking. timeout:false leaves cancellation to our controller.
        const res = await fetch(`${consultant.endpoint}/chat/completions`, {
          // @ts-expect-error Bun extension: disable fetch's built-in timeout
          timeout: false,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(consultant.apiKey && { authorization: `Bearer ${consultant.apiKey}` }),
          },
          signal: controller.signal,
          body: JSON.stringify({
            model: consultant.model,
            messages: [
              { role: 'system', content: CONSULTANT_SYSTEM_PROMPT },
              { role: 'user', content: body },
            ],
            max_tokens: consultant.maxTokens,
            stream: false,
            ...(consultant.temperature !== undefined && { temperature: consultant.temperature }),
          }),
        })
        if (!res.ok) {
          const text = (await res.text()).slice(0, 500)
          return {
            success: false,
            output: `Consultant ${consultant.name} returned HTTP ${res.status}: ${text}`,
          }
        }
        const data = (await res.json()) as ConsultResponse
        const message = data.choices?.[0]?.message
        const content = message?.content?.trim()
        if (content) {
          return { success: true, output: `${consultant.name} replied:\n\n${content}` }
        }
        // Reasoning models can spend the whole token budget thinking (vLLM puts thinking in
        // `reasoning`, llama.cpp in `reasoning_content`). Surface the tail of the thinking
        // rather than returning nothing — a partial insight beats an empty answer.
        const reasoning = message?.reasoning ?? message?.reasoning_content
        if (reasoning?.trim()) {
          return {
            success: true,
            output: `${consultant.name} ran out of answer budget while thinking. The tail of its reasoning:\n\n...${reasoning.trim().slice(-3000)}\n\nConsider re-asking with a narrower question.`,
          }
        }
        return {
          success: false,
          output: `Consultant ${consultant.name} returned an empty answer${data.error?.message ? `: ${data.error.message}` : '.'}`,
        }
      } catch (e) {
        const aborted = controller.signal.aborted
        return {
          success: false,
          output: aborted
            ? `Consultant ${consultant.name} timed out after ${consultant.timeoutMs}ms. Large contexts take a while — consider fewer attachments or a longer timeout.`
            : `Failed to reach consultant ${consultant.name}: ${e}`,
        }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
