import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeServerProps, serverSupportsVision } from '../../src/providers/server-props'
import { createDefaultToolExecutor } from '../../src/tools'
import { makeConfig } from '../agent/helpers'

describe('serverSupportsVision', () => {
  const probeVisionSupport = async (url: string) =>
    serverSupportsVision(await probeServerProps(url))
  let visionOn = false
  let respond404 = false
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      if (respond404 || !new URL(req.url).pathname.endsWith('/props')) {
        return new Response('not found', { status: 404 })
      }
      return Response.json({ modalities: { vision: visionOn, audio: false } })
    },
  })
  afterAll(() => server.stop(true))
  const endpoint = `http://localhost:${server.port}`

  test('vision true when the server reports it', async () => {
    visionOn = true
    expect(await probeVisionSupport(endpoint)).toBe(true)
  })

  test('vision false when the server says no', async () => {
    visionOn = false
    expect(await probeVisionSupport(endpoint)).toBe(false)
  })

  test('no /props endpoint means no', async () => {
    respond404 = true
    expect(await probeVisionSupport(endpoint)).toBe(false)
    respond404 = false
  })

  test('unreachable endpoint means no', async () => {
    expect(await probeVisionSupport('http://127.0.0.1:1')).toBe(false)
  })
})

describe('screenshot tool gating', () => {
  function build(screenshot: boolean | 'auto', visionSupported?: boolean) {
    const ws = mkdtempSync(join(tmpdir(), 'egirl-gate-'))
    const config = { ...makeConfig(ws), tools: { ...makeConfig(ws).tools, screenshot } }
    const ex = createDefaultToolExecutor(
      config,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      visionSupported,
    )
    return ex.listTools()
  }

  test('auto + vision → registered', () => {
    expect(build('auto', true)).toContain('screenshot')
  })

  test('auto + no vision → not registered', () => {
    expect(build('auto', false)).not.toContain('screenshot')
  })

  test('explicit true overrides missing vision', () => {
    expect(build(true, false)).toContain('screenshot')
  })

  test('explicit false wins regardless', () => {
    expect(build(false, true)).not.toContain('screenshot')
  })
})
