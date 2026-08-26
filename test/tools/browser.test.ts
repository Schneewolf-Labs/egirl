import { describe, expect, test } from 'bun:test'
import { BrowserManager } from '../../src/browser'
import { createBrowserTools } from '../../src/tools/builtin/browser'

describe('browser tools', () => {
  // Use a fresh manager for structure tests — no browser is launched
  // because we only test definitions, not execution
  const manager = new BrowserManager()
  const tools = createBrowserTools(manager)

  describe('tool definitions', () => {
    test('browser_navigate has correct definition', () => {
      const def = tools.browserNavigateTool.definition
      expect(def.name).toBe('browser_navigate')
      expect(def.parameters.required).toEqual(['url'])
      expect(def.parameters.properties.url).toBeDefined()
    })

    test('browser_click has correct definition', () => {
      const def = tools.browserClickTool.definition
      expect(def.name).toBe('browser_click')
      expect(def.parameters.required).toEqual(['target'])
      expect(def.parameters.properties.target).toBeDefined()
    })

    test('browser_fill has correct definition', () => {
      const def = tools.browserFillTool.definition
      expect(def.name).toBe('browser_fill')
      expect(def.parameters.required).toEqual(['target', 'value'])
      expect(def.parameters.properties.target).toBeDefined()
      expect(def.parameters.properties.value).toBeDefined()
    })

    test('browser_snapshot has correct definition', () => {
      const def = tools.browserSnapshotTool.definition
      expect(def.name).toBe('browser_snapshot')
    })

    test('browser_screenshot has correct definition', () => {
      const def = tools.browserScreenshotTool.definition
      expect(def.name).toBe('browser_screenshot')
    })

    test('browser_select has correct definition', () => {
      const def = tools.browserSelectTool.definition
      expect(def.name).toBe('browser_select')
      expect(def.parameters.required).toEqual(['target', 'value'])
    })

    test('browser_check has correct definition', () => {
      const def = tools.browserCheckTool.definition
      expect(def.name).toBe('browser_check')
      expect(def.parameters.required).toEqual(['target'])
      expect(def.parameters.properties.checked).toBeDefined()
    })

    test('browser_hover has correct definition', () => {
      const def = tools.browserHoverTool.definition
      expect(def.name).toBe('browser_hover')
      expect(def.parameters.required).toEqual(['target'])
    })

    test('browser_wait has correct definition', () => {
      const def = tools.browserWaitTool.definition
      expect(def.name).toBe('browser_wait')
      expect(def.parameters.required).toEqual(['target'])
      expect(def.parameters.properties.timeout).toBeDefined()
    })

    test('browser_eval has correct definition', () => {
      const def = tools.browserEvalTool.definition
      expect(def.name).toBe('browser_eval')
      expect(def.parameters.required).toEqual(['expression'])
    })

    test('browser_close has correct definition', () => {
      const def = tools.browserCloseTool.definition
      expect(def.name).toBe('browser_close')
    })

    test('all tools have descriptions mentioning accessibility or their purpose', () => {
      const allTools = Object.values(tools)
      for (const tool of allTools) {
        expect(tool.definition.description).toBeTruthy()
        expect(tool.definition.description.length).toBeGreaterThan(10)
      }
    })
  })

  describe('input validation', () => {
    test('navigate rejects non-http URLs', async () => {
      const result = await tools.browserNavigateTool.execute({ url: 'ftp://example.com' }, '/tmp')
      expect(result.success).toBe(false)
      expect(result.output).toContain('http')
    })

    test('navigate rejects URLs without protocol', async () => {
      const result = await tools.browserNavigateTool.execute({ url: 'example.com' }, '/tmp')
      expect(result.success).toBe(false)
      expect(result.output).toContain('http')
    })
  })

  describe('error handling', () => {
    // These tests verify tools return ToolResult with success: false
    // instead of throwing when Playwright is not available

    test('navigate handles missing browser gracefully', async () => {
      const result = await tools.browserNavigateTool.execute(
        { url: 'http://localhost:99999' },
        '/tmp',
      )
      expect(result.success).toBe(false)
      expect(result.output).toBeTruthy()
    })

    // Behaviour here genuinely depends on the environment, and pinning either outcome makes the
    // test assert the machine rather than the code. snapshot() and click() both go through
    // ensurePage(), which launches on demand: with Playwright's chromium installed they succeed,
    // without it they fail on the missing binary. The original tests asserted failure and so
    // passed only on machines with no browser; asserting success instead just moved the problem.
    //
    // The invariant that holds either way — and the one the tests were named for — is that the
    // tool handles it gracefully: it returns a well-formed ToolResult with output rather than
    // throwing. Both branches also close the browser, since without that the suite leaked
    // processes ("killed 3 dangling processes").
    test('snapshot handles a fresh manager gracefully', async () => {
      const freshManager = new BrowserManager()
      const freshTools = createBrowserTools(freshManager)
      try {
        const result = await freshTools.browserSnapshotTool.execute({}, '/tmp')
        expect(typeof result.success).toBe('boolean')
        expect(result.output).toBeTruthy()
      } finally {
        await freshManager.close()
      }
    }, 40000)

    // Generous deadline: the action itself is bounded by the manager's 10s default timeout
    // (lowered from Playwright's 30s, which hung the agent for half a minute on any mistyped
    // selector), but this test launches a FRESH chromium, and under full-suite parallelism
    // that launch alone has been observed to eat a 40s deadline.
    test('click handles a missing element gracefully', async () => {
      const freshManager = new BrowserManager()
      const freshTools = createBrowserTools(freshManager)
      try {
        const result = await freshTools.browserClickTool.execute(
          { target: 'button/Submit' },
          '/tmp',
        )
        // No Submit button exists on a blank page, and no page exists at all without a browser.
        // Either way this must fail cleanly rather than throw.
        expect(result.success).toBe(false)
        expect(result.output).toBeTruthy()
      } finally {
        await freshManager.close()
      }
    }, 120000)

    test('close always succeeds even without open browser', async () => {
      const freshManager = new BrowserManager()
      const freshTools = createBrowserTools(freshManager)
      const result = await freshTools.browserCloseTool.execute({}, '/tmp')
      expect(result.success).toBe(true)
    })
  })
})
