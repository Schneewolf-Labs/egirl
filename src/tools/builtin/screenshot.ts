import { readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tool, ToolResult } from '../types'

interface ScreenshotParams {
  display?: string
  region?: {
    x: number
    y: number
    width: number
    height: number
  }
}

async function commandExists(cmd: string): Promise<boolean> {
  const proc = Bun.spawn(['which', cmd], { stdout: 'ignore', stderr: 'ignore' })
  const code = await proc.exited
  return code === 0
}

async function captureScreenshot(params: ScreenshotParams): Promise<string> {
  const tmpPath = join(tmpdir(), `egirl-screenshot-${Date.now()}.png`)

  // Try available screenshot tools in order of preference
  const tools = [
    { cmd: 'grim', args: [tmpPath] }, // Wayland
    { cmd: 'scrot', args: [tmpPath] }, // X11
    { cmd: 'maim', args: [tmpPath] }, // X11 alternative
    { cmd: 'gnome-screenshot', args: ['-f', tmpPath] }, // GNOME fallback
  ]

  let captured = false

  for (const tool of tools) {
    if (await commandExists(tool.cmd)) {
      let args = [...tool.args]

      // Handle region capture for supported tools
      if (params.region) {
        const { x, y, width, height } = params.region
        if (tool.cmd === 'grim') {
          args = ['-g', `${x},${y} ${width}x${height}`, tmpPath]
        } else if (tool.cmd === 'maim') {
          args = ['-g', `${width}x${height}+${x}+${y}`, tmpPath]
        } else if (tool.cmd === 'scrot') {
          args = ['-a', `${x},${y},${width},${height}`, tmpPath]
        }
        // gnome-screenshot doesn't support region via CLI easily
      }

      const proc = Bun.spawn([tool.cmd, ...args], {
        stdout: 'ignore',
        stderr: 'pipe',
      })

      const code = await proc.exited

      if (code === 0) {
        captured = true
        break
      }
    }
  }

  if (!captured) {
    throw new Error('No screenshot tool available. Install grim (Wayland), scrot, or maim (X11).')
  }

  // Read and encode the image
  const imageBuffer = await readFile(tmpPath)
  const base64 = imageBuffer.toString('base64')

  // Clean up temp file
  await unlink(tmpPath).catch(() => {})

  return `data:image/png;base64,${base64}`
}

export const screenshotTool: Tool = {
  definition: {
    name: 'screenshot',
    description:
      'Capture a screenshot of the current display. Returns the image for visual analysis.',
    parameters: {
      type: 'object',
      properties: {
        display: {
          type: 'string',
          description: 'Display to capture (default: primary)',
        },
        region: {
          type: 'object',
          description: 'Optional region to capture',
          properties: {
            x: { type: 'number', description: 'X coordinate' },
            y: { type: 'number', description: 'Y coordinate' },
            width: { type: 'number', description: 'Width in pixels' },
            height: { type: 'number', description: 'Height in pixels' },
          },
        },
      },
    },
  },

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    try {
      const imageUrl = await captureScreenshot(params as ScreenshotParams)

      return {
        success: true,
        output: imageUrl,
        isImage: true,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        success: false,
        output: `Screenshot failed: ${message}`,
      }
    }
  },
}
