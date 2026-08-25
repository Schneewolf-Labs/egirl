import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ConsultantEntry,
  createConsultTool,
  packConsultation,
  truncateMiddle,
} from '../../src/tools/builtin/consult'

describe('truncateMiddle', () => {
  test('returns short text unchanged', () => {
    expect(truncateMiddle('hello', 100)).toBe('hello')
  })

  test('keeps head and tail with a marker', () => {
    const text = `HEAD${'x'.repeat(5000)}TAIL`
    const out = truncateMiddle(text, 400)
    expect(out).toContain('HEAD')
    expect(out).toContain('TAIL')
    expect(out).toContain('middle truncated')
    expect(out.length).toBeLessThan(500)
  })
})

describe('packConsultation', () => {
  test('assembles context, files, and question in order', () => {
    const out = packConsultation(
      'is my parser right?',
      [{ path: 'NOTES.md', content: 'the notes' }],
      'recent finding: it crashes',
      100000,
    )
    expect(out.indexOf('## Context')).toBeLessThan(out.indexOf('## File: NOTES.md'))
    expect(out.indexOf('## File: NOTES.md')).toBeLessThan(out.indexOf('## Question'))
    expect(out).toContain('is my parser right?')
  })

  test('splits the file budget and truncates oversized files', () => {
    const big = 'a'.repeat(50000)
    const out = packConsultation(
      'q',
      [
        { path: 'a.md', content: big },
        { path: 'b.md', content: big },
      ],
      undefined,
      20000,
    )
    expect(out).toContain('middle truncated')
    expect(out.length).toBeLessThan(30000)
  })
})

describe('consult tool', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'egirl-consult-'))
  writeFileSync(join(workspace, 'NOTES.md'), 'PROVEN: decompressor byte-exact')

  // Mock OpenAI-compatible endpoint capturing the request.
  let lastBody: Record<string, unknown> | undefined
  let replyWith: Record<string, unknown> = {
    choices: [{ message: { content: 'Check the RIFF header offset.' } }],
  }
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      lastBody = (await req.json()) as Record<string, unknown>
      return Response.json(replyWith)
    },
  })
  afterAll(() => server.stop(true))

  const entry: ConsultantEntry = {
    name: 'deepseek',
    endpoint: `http://localhost:${server.port}`,
    model: 'deepseek-v4',
    contextLength: 131072,
    maxTokens: 4096,
    timeoutMs: 10000,
  }

  test('packages files from the workspace and returns the answer', async () => {
    const tool = createConsultTool([entry], workspace)
    const result = await tool.execute(
      { question: 'what am I missing?', files: ['NOTES.md'] },
      workspace,
    )
    expect(result.success).toBe(true)
    expect(result.output).toContain('deepseek replied:')
    expect(result.output).toContain('RIFF header offset')
    const messages = lastBody?.messages as Array<{ role: string; content: string }>
    expect(messages[1]?.content).toContain('PROVEN: decompressor byte-exact')
    expect(messages[1]?.content).toContain('what am I missing?')
  })

  test('missing file is reported inline, not fatal', async () => {
    const tool = createConsultTool([entry], workspace)
    const result = await tool.execute({ question: 'q', files: ['nope.md'] }, workspace)
    expect(result.success).toBe(true)
    const messages = lastBody?.messages as Array<{ role: string; content: string }>
    expect(messages[1]?.content).toContain('[file could not be read')
  })

  test('surfaces reasoning tail when the answer budget was spent thinking', async () => {
    replyWith = {
      choices: [{ message: { content: '', reasoning: 'deep thoughts about headers' } }],
    }
    const tool = createConsultTool([entry], workspace)
    const result = await tool.execute({ question: 'q' }, workspace)
    expect(result.success).toBe(true)
    expect(result.output).toContain('deep thoughts about headers')
    replyWith = { choices: [{ message: { content: 'ok' } }] }
  })

  test('unknown consultant name errors with the configured list', async () => {
    const tool = createConsultTool([entry], workspace)
    const result = await tool.execute({ question: 'q', consultant: 'grok' }, workspace)
    expect(result.success).toBe(false)
    expect(result.output).toContain('deepseek')
  })

  test('question is required', async () => {
    const tool = createConsultTool([entry], workspace)
    const result = await tool.execute({}, workspace)
    expect(result.success).toBe(false)
  })
})
