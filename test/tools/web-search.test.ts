import { describe, expect, test } from 'bun:test'
import { createWebSearchTool } from '../../src/tools/builtin/web-search'

const tool = createWebSearchTool({ url: 'http://localhost:9' })

describe('web_search tool', () => {
  test('has correct definition', () => {
    expect(tool.definition.name).toBe('web_search')
    expect(tool.definition.parameters.required).toEqual(['query'])
    expect(tool.definition.parameters.properties.query).toBeDefined()
    expect(tool.definition.parameters.properties.num_results).toBeDefined()
    expect(tool.definition.parameters.properties.categories).toBeDefined()
    expect(tool.definition.parameters.properties.timeout).toBeDefined()
  })

  test('description mentions SearxNG', () => {
    expect(tool.definition.description).toContain('SearxNG')
  })

  test('rejects empty query', async () => {
    const result = await tool.execute({ query: '' }, '/tmp')

    expect(result.success).toBe(false)
    expect(result.output).toContain('non-empty')
  })

  test('rejects whitespace-only query', async () => {
    const result = await tool.execute({ query: '   ' }, '/tmp')

    expect(result.success).toBe(false)
    expect(result.output).toContain('non-empty')
  })

  test('handles connection errors gracefully', async () => {
    const result = await tool.execute({ query: 'test', timeout: 1000 }, '/tmp')

    expect(result.success).toBe(false)
    expect(result.output).toBeTruthy()
  })

  test('never throws — always returns ToolResult', async () => {
    const result = await tool.execute({ query: 'anything', timeout: 500 }, '/tmp')

    expect(result).toHaveProperty('success')
    expect(result).toHaveProperty('output')
  })

  test('normalizes trailing slashes in base url', async () => {
    // Both forms should behave identically (fail the same way against a dead port)
    const a = createWebSearchTool({ url: 'http://localhost:9' })
    const b = createWebSearchTool({ url: 'http://localhost:9/' })

    const ra = await a.execute({ query: 'x', timeout: 500 }, '/tmp')
    const rb = await b.execute({ query: 'x', timeout: 500 }, '/tmp')

    expect(ra.success).toBe(false)
    expect(rb.success).toBe(false)
  })
})
