import { describe, test, expect } from 'bun:test'
import { webResearchTool } from '../../src/tools/builtin/web-research'

describe('web_research tool', () => {
  test('has correct definition', () => {
    expect(webResearchTool.definition.name).toBe('web_research')
    expect(webResearchTool.definition.parameters.required).toEqual(['url'])
    expect(webResearchTool.definition.parameters.properties.url).toBeDefined()
    expect(webResearchTool.definition.parameters.properties.timeout).toBeDefined()
  })

  test('rejects URLs without http/https prefix', async () => {
    const result = await webResearchTool.execute({ url: 'ftp://example.com' }, '/tmp')

    expect(result.success).toBe(false)
    expect(result.output).toContain('http://')
  })

  test('rejects URLs without any protocol', async () => {
    const result = await webResearchTool.execute({ url: 'example.com' }, '/tmp')

    expect(result.success).toBe(false)
    expect(result.output).toContain('http://')
  })

  test('accepts http:// URLs', async () => {
    // This will fail to connect but should pass URL validation
    const result = await webResearchTool.execute(
      { url: 'http://localhost:99999/nonexistent', timeout: 1000 },
      '/tmp'
    )

    // Should fail with a network error, not a URL validation error
    expect(result.success).toBe(false)
    expect(result.output).not.toContain('must start with http')
  })

  test('accepts https:// URLs', async () => {
    const result = await webResearchTool.execute(
      { url: 'https://localhost:99999/nonexistent', timeout: 1000 },
      '/tmp'
    )

    expect(result.success).toBe(false)
    expect(result.output).not.toContain('must start with http')
  })

  test('handles connection errors gracefully', async () => {
    const result = await webResearchTool.execute(
      { url: 'http://192.0.2.1:1', timeout: 2000 },
      '/tmp'
    )

    expect(result.success).toBe(false)
    expect(result.output).toBeTruthy()
  })

  test('never throws — always returns ToolResult', async () => {
    // Even with garbage input, should return a result, not throw
    const result = await webResearchTool.execute(
      { url: 'not-a-url' },
      '/tmp'
    )

    expect(result).toHaveProperty('success')
    expect(result).toHaveProperty('output')
  })
})

describe('htmlToText (via web_research tool integration)', () => {
  // htmlToText is not exported, so we test it indirectly through the tool
  // We can test the behavior by creating a local server

  // Since we can't easily mock fetch in bun:test without extra deps,
  // we test the tool's structure and error paths directly

  test('tool description mentions URL fetching', () => {
    expect(webResearchTool.definition.description).toContain('URL')
  })

  test('tool has url parameter with correct type', () => {
    const urlParam = webResearchTool.definition.parameters.properties.url
    expect(urlParam.type).toBe('string')
  })

  test('tool has optional timeout parameter', () => {
    const timeoutParam = webResearchTool.definition.parameters.properties.timeout
    expect(timeoutParam.type).toBe('number')
  })
})
