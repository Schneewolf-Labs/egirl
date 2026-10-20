import type { AgentLoop, AgentResponse } from './agent'
import { subscribe } from './agent/session-events'
import { applyStop, parseRequestParams } from './openai-params'
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

export interface ChatCompletionsOptions {
  /** The instance name, reported as the model. */
  model: string
  /** Stream reasoning, tool activity and pre-tool text as reasoning_content. */
  exposeProgress: boolean
}

/** Cut at a stop sequence, and say why the answer ended the way OpenAI clients expect. */
function finalAnswer(res: AgentResponse, stop: string[] | undefined) {
  const content = applyStop(res.content, stop)
  const finish = res.truncated && content === res.content ? 'length' : 'stop'
  return { content, finish }
}

export async function handleChatCompletions(
  req: Request,
  body: Record<string, unknown>,
  factory: StatelessAgentFactory,
  opts: ChatCompletionsOptions,
): Promise<Response> {
  const parsed = parseChatRequest(body)
  if (typeof parsed === 'string') return openaiError(parsed, 400)
  const params = parseRequestParams(body)
  if (typeof params === 'string') return openaiError(params, 400)

  const { model } = opts
  const agent = factory({ history: parsed.history, note: parsed.note })
  const id = `chatcmpl-${crypto.randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  const runOpts = {
    ...(parsed.images.length > 0 && { images: parsed.images }),
    ...(params.sampling && { sampling: params.sampling }),
  }

  if (body.stream !== true) {
    try {
      const res = await agent.run(parsed.message, { ...runOpts, signal: req.signal })
      const { content, finish } = finalAnswer(res, params.stop)
      return Response.json({
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finish }],
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

      // Only the answer is content, and a turn's text can't be known to be the answer until
      // the turn ends without a tool call -- so tokens are never streamed as content. The
      // answer goes out whole when the run ends (the SSE keepalive holds the connection
      // meanwhile): no token-by-token answer, in exchange for never showing a "let me look
      // that up" preamble as if it were the reply. With exposeProgress, a UI gets the run as
      // reasoning_content instead: thinking, each tool call, and the text written before it.
      let turnText = ''
      const unsubscribe = opts.exposeProgress
        ? subscribe(sessionId, (ev) => {
            if (ev.t === 'reasoning') chunk({ reasoning_content: ev.v })
            else if (ev.t === 'token') turnText += ev.v
            else if (ev.t === 'tool') {
              const calls = ev.v.map((c) => `\n→ ${c.name}\n`).join('')
              chunk({ reasoning_content: turnText + calls })
              turnText = ''
            }
          })
        : () => {}
      try {
        const res = await agent.run(parsed.message, { ...runOpts, signal: closed })
        const { content, finish } = finalAnswer(res, params.stop)
        if (content) chunk({ content })
        chunk({}, finish)
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
