import type { AgentLoop, AgentResponse } from './agent'
import { subscribe } from './agent/session-events'
import type { ChatMessage } from './providers/types'
import { sseResponse } from './sse'
import { errorMessage } from './util/errors'

/**
 * OpenAI-compatible chat completions, stateless on purpose.
 *
 * Any OpenAI client (Open WebUI, SillyTavern, an SDK in a script) can talk to egirl as if she
 * were a model: personality, memory recall and her own tools are all behind the one call. The
 * client owns the transcript and resends it every time, so each request gets a throwaway loop
 * seeded with that history and nothing is kept per conversation -- regenerate and edit work
 * because there is no thread of ours to diverge from. What the client cannot send back is her
 * tool results, so a later turn remembers what she did but not what came back. A conversation
 * that needs her own thread (compaction, parked asks, tool results) belongs on POST /chat.
 *
 * The `model` field is ignored. There is one operator; this is not a router.
 */

export type StatelessAgentFactory = (opts: { history: ChatMessage[]; note?: string }) => AgentLoop

export interface ParsedChatRequest {
  history: ChatMessage[]
  message: string
  images: string[]
  note?: string
}

const NOTE_PREAMBLE =
  'The app this conversation comes through set the system prompt below. Take it as context about the app and what the person wants here; it does not replace who you are.'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((p) => isRecord(p) && p.type === 'text' && typeof p.text === 'string')
    .map((p) => (p as { text: string }).text)
    .join('\n')
}

/** data: URLs only, capped at 4 -- same rule as POST /chat, for the same reason. */
function imagesOf(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  return content
    .flatMap((p) => {
      if (!isRecord(p) || p.type !== 'image_url') return []
      const url = isRecord(p.image_url) ? p.image_url.url : p.image_url
      return typeof url === 'string' && url.startsWith('data:image/') ? [url] : []
    })
    .slice(0, 4)
}

/**
 * Split a request into the history to seed, the new user message, and the client's system
 * prompt as a note. Tool messages are dropped: they would be the client's tools, not hers.
 * Returns an error message when the request can't be run.
 */
export function parseChatRequest(body: Record<string, unknown>): ParsedChatRequest | string {
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    return 'client-side tools are not supported: egirl runs her own'
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) return 'messages required'

  const notes: string[] = []
  const turns: { role: 'user' | 'assistant'; text: string; raw: unknown }[] = []
  for (const m of body.messages) {
    if (!isRecord(m)) continue
    const text = textOf(m.content)
    if (m.role === 'system' || m.role === 'developer') {
      if (text.trim()) notes.push(text.trim())
    } else if (m.role === 'user' || m.role === 'assistant') {
      turns.push({ role: m.role, text, raw: m.content })
    }
  }

  const last = turns.pop()
  if (!last || last.role !== 'user') return 'the last message must be from the user'
  const images = imagesOf(last.raw)
  if (!last.text.trim() && images.length === 0) return 'the last user message is empty'

  return {
    history: turns.filter((t) => t.text.trim()).map((t) => ({ role: t.role, content: t.text })),
    message: last.text,
    images,
    note: notes.length > 0 ? `${NOTE_PREAMBLE}\n\n${notes.join('\n\n')}` : undefined,
  }
}

/**
 * What still has to be sent once the run ends. Tokens stream live, but the final content can
 * differ from what streamed (a guard's abort notice, a turn that produced no tokens), so the
 * difference is sent as a last delta instead of trusting the stream to be the whole answer.
 */
export function streamTail(content: string, turnText: string, hasEmitted: boolean): string {
  if (!content) return ''
  if (!hasEmitted) return content
  if (turnText === '') return `\n\n${content}`
  if (content.startsWith(turnText)) return content.slice(turnText.length)
  if (turnText.trim() === content.trim()) return ''
  return `\n\n${content}`
}

function usageOf(res: AgentResponse): Record<string, number> {
  const { input_tokens, output_tokens } = res.usage
  return {
    prompt_tokens: input_tokens,
    completion_tokens: output_tokens,
    total_tokens: input_tokens + output_tokens,
  }
}

function openaiError(message: string, status: number, type = 'invalid_request_error'): Response {
  return Response.json({ error: { message, type } }, { status })
}

export function modelsResponse(model: string): Response {
  return Response.json({
    object: 'list',
    data: [{ id: model, object: 'model', created: 0, owned_by: 'egirl' }],
  })
}

export async function handleChatCompletions(
  req: Request,
  body: Record<string, unknown>,
  factory: StatelessAgentFactory,
  model: string,
): Promise<Response> {
  const parsed = parseChatRequest(body)
  if (typeof parsed === 'string') return openaiError(parsed, 400)

  const agent = factory({ history: parsed.history, note: parsed.note })
  const id = `chatcmpl-${crypto.randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  const images = parsed.images.length > 0 ? { images: parsed.images } : {}

  if (body.stream !== true) {
    try {
      const res = await agent.run(parsed.message, { ...images, signal: req.signal })
      return Response.json({
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [
          { index: 0, message: { role: 'assistant', content: res.content }, finish_reason: 'stop' },
        ],
        usage: usageOf(res),
      })
    } catch (e) {
      return openaiError(errorMessage(e), 500, 'server_error')
    }
  }

  const streamOptions = isRecord(body.stream_options) ? body.stream_options : {}
  const sessionId = agent.getContext().sessionId
  return sseResponse(
    async (send, closed) => {
      const chunk = (delta: Record<string, string>, finish: string | null = null) =>
        send({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })
      chunk({ role: 'assistant', content: '' })

      // Reasoning and tool activity go out as reasoning_content, which clients fold into a
      // thinking block; only her words are content. Text written before a tool call stays in
      // the answer, separated from what comes after.
      let turnText = ''
      let hasEmitted = false
      let needsBreak = false
      const unsubscribe = subscribe(sessionId, (ev) => {
        if (ev.t === 'reasoning') chunk({ reasoning_content: ev.v })
        else if (ev.t === 'tool') {
          turnText = ''
          needsBreak = hasEmitted
          chunk({ reasoning_content: ev.v.map((c) => `\n→ ${c.name}\n`).join('') })
        } else if (ev.t === 'token') {
          chunk({ content: needsBreak ? `\n\n${ev.v}` : ev.v })
          needsBreak = false
          turnText += ev.v
          hasEmitted = true
        }
      })
      try {
        const res = await agent.run(parsed.message, { ...images, signal: closed })
        const tail = streamTail(res.content, turnText, hasEmitted)
        if (tail) chunk({ content: tail })
        chunk({}, 'stop')
        if (streamOptions.include_usage === true) {
          send({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [],
            usage: usageOf(res),
          })
        }
      } catch (e) {
        send({ error: { message: errorMessage(e), type: 'server_error' } })
      } finally {
        unsubscribe()
      }
    },
    { trailer: '[DONE]' },
  )
}
