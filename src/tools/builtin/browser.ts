import type { BrowserManager, PageSnapshot } from '../../browser'
import type { Tool, ToolResult } from '../types'

function formatSnapshot(snap: PageSnapshot): string {
  return `URL: ${snap.url}\nTitle: ${snap.title}\n\n${snap.content}`
}

/**
 * Create browser automation tools backed by a shared BrowserManager instance.
 * The manager persists across tool calls so navigation state is retained.
 */
export function createBrowserTools(manager: BrowserManager): {
  browserNavigateTool: Tool
  browserClickTool: Tool
  browserFillTool: Tool
  browserSnapshotTool: Tool
  browserScreenshotTool: Tool
  browserSelectTool: Tool
  browserCheckTool: Tool
  browserHoverTool: Tool
  browserWaitTool: Tool
  browserEvalTool: Tool
  browserCloseTool: Tool
} {
  const browserNavigateTool: Tool = {
    definition: {
      name: 'browser_navigate',
      description: 'Navigate the browser to a URL. Returns a text snapshot of the page content.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to navigate to (must start with http:// or https://)',
          },
        },
        required: ['url'],
      },
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const url = params.url as string

      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        return { success: false, output: 'URL must start with http:// or https://' }
      }

      try {
        const snap = await manager.navigate(url)
        return { success: true, output: formatSnapshot(snap) }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { success: false, output: `Navigation failed: ${message}` }
      }
    },
  }

  const browserClickTool: Tool = {
    definition: {
      name: 'browser_click',
      description: [
        'Click an element on the page using accessibility targeting.',
        'Target format: "role/Name" for ARIA roles (e.g. "button/Submit", "link/Home"),',
        '"text:value" for text content, "label:value" for form labels,',
        '"placeholder:value", "testid:value", "title:value", or "css:selector" as escape hatch.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description:
              'Element target ref (e.g. "button/Submit", "link/Home", "text:Click here")',
          },
        },
        required: ['target'],
      },
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const target = params.target as string

      try {
        const snap = await manager.click(target)
        return { success: true, output: formatSnapshot(snap) }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { success: false, output: `Click failed: ${message}` }
      }
    },
  }

  const browserFillTool: Tool = {
    definition: {
      name: 'browser_fill',
      description: [
        'Fill a form field using accessibility targeting.',
        'Target format: "role/Name" (e.g. "textbox/Email"), "label:value", "placeholder:value",',
        'or other supported targeting strategies.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description:
              'Element target ref (e.g. "textbox/Email", "label:Password", "placeholder:Search...")',
          },
          value: {
            type: 'string',
            description: 'The text to fill into the field',
          },
        },
        required: ['target', 'value'],
      },
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const target = params.target as string
      const value = params.value as string

      try {
        const snap = await manager.fill(target, value)
        return { success: true, output: formatSnapshot(snap) }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { success: false, output: `Fill failed: ${message}` }
      }
    },
  }

  const browserSnapshotTool: Tool = {
    definition: {
      name: 'browser_snapshot',
      description:
        'Get a text snapshot of the current page content, including visible text and interactive elements.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },

    async execute(): Promise<ToolResult> {
      try {
        const snap = await manager.snapshot()
        return { success: true, output: formatSnapshot(snap) }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { success: false, output: `Snapshot failed: ${message}` }
      }
    },
  }

  const browserScreenshotTool: Tool = {
    definition: {
      name: 'browser_screenshot',
      description:
        'Take a screenshot of the current browser page. Returns the image for visual analysis.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },

    async execute(): Promise<ToolResult> {
      try {
        const dataUrl = await manager.screenshot()
        return { success: true, output: dataUrl, isImage: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { success: false, output: `Screenshot failed: ${message}` }
      }
    },
  }

  const browserSelectTool: Tool = {
    definition: {
      name: 'browser_select',
      description: 'Select an option from a dropdown/select element using accessibility targeting.',
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: 'Element target ref (e.g. "combobox/Country", "label:State")',
          },
          value: {
            type: 'string',
            description: 'The option value or label to select',
          },
        },
        required: ['target', 'value'],
      },
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const target = params.target as string
      const value = params.value as string

      try {
        const snap = await manager.selectOption(target, value)
        return { success: true, output: formatSnapshot(snap) }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { success: false, output: `Select failed: ${message}` }
      }
    },
  }

  const browserCheckTool: Tool = {
    definition: {
      name: 'browser_check',
      description: 'Check or uncheck a checkbox element using accessibility targeting.',
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: 'Element target ref (e.g. "checkbox/Remember me", "label:Terms")',
          },
          checked: {
            type: 'boolean',
            description: 'Whether to check (true) or uncheck (false) the element. Default: true',
          },
        },
        required: ['target'],
      },
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const target = params.target as string
      const checked = (params.checked as boolean | undefined) ?? true

      try {
        const snap = checked ? await manager.check(target) : await manager.uncheck(target)
        return { success: true, output: formatSnapshot(snap) }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { success: false, output: `Check failed: ${message}` }
      }
    },
  }

  const browserHoverTool: Tool = {
    definition: {
      name: 'browser_hover',
      description: 'Hover over an element using accessibility targeting.',
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: 'Element target ref (e.g. "button/Menu", "link/Profile")',
          },
        },
        required: ['target'],
      },
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const target = params.target as string

      try {
        const snap = await manager.hover(target)
        return { success: true, output: formatSnapshot(snap) }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { success: false, output: `Hover failed: ${message}` }
      }
    },
  }

  const browserWaitTool: Tool = {
    definition: {
      name: 'browser_wait',
      description: 'Wait for an element to become visible on the page.',
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description:
              'Element target ref to wait for (e.g. "heading/Results", "text:Loading complete")',
          },
          timeout: {
            type: 'number',
            description: 'Maximum time to wait in milliseconds (default: 30000)',
          },
        },
        required: ['target'],
      },
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const target = params.target as string
      const timeout = params.timeout as number | undefined

      try {
        const snap = await manager.waitFor(target, timeout)
        return { success: true, output: formatSnapshot(snap) }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { success: false, output: `Wait failed: ${message}` }
      }
    },
  }

  const browserEvalTool: Tool = {
    definition: {
      name: 'browser_eval',
      description:
        'Evaluate a JavaScript expression in the browser page context. Use sparingly — prefer accessibility targeting for interactions.',
      parameters: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description: 'JavaScript expression to evaluate in the page context',
          },
        },
        required: ['expression'],
      },
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const expression = params.expression as string

      try {
        const result = await manager.evaluate(expression)
        const output = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
        return { success: true, output: output ?? 'undefined' }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { success: false, output: `Eval failed: ${message}` }
      }
    },
  }

  const browserCloseTool: Tool = {
    definition: {
      name: 'browser_close',
      description:
        'Close the browser. The browser will be relaunched automatically on the next browser action.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },

    async execute(): Promise<ToolResult> {
      try {
        await manager.close()
        return { success: true, output: 'Browser closed' }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { success: false, output: `Close failed: ${message}` }
      }
    },
  }

  return {
    browserNavigateTool,
    browserClickTool,
    browserFillTool,
    browserSnapshotTool,
    browserScreenshotTool,
    browserSelectTool,
    browserCheckTool,
    browserHoverTool,
    browserWaitTool,
    browserEvalTool,
    browserCloseTool,
  }
}
