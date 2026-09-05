import { readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { errorMessage } from '../../util/errors'
import { log } from '../../util/logger'
import type { Tool, ToolResult } from '../types'

interface ScreenshotParams {
  display?: string
  window?: boolean
  maxWidth?: number
  region?: {
    x: number
    y: number
    width: number
    height: number
  }
}

/**
 * Vision encoders tile an image at a fixed patch size, so a 3440x1440 capture costs several times
 * a 1280-wide one and resolves no more text -- the desktop is mostly empty pixels. Downscaling is
 * also what keeps the base64 payload sane: the same capture is ~2.5MB of base64 at full size.
 *
 * Best effort by design. ImageMagick then ffmpeg, and if neither is installed the full-size image
 * is returned rather than failing, since a large screenshot still works.
 */
const DEFAULT_MAX_WIDTH = 1280

/** The focused window's id, when a tool exists that can tell us. */
async function focusedWindowId(): Promise<string | undefined> {
  if (!(await commandExists('xdotool'))) return undefined
  const proc = Bun.spawn(['xdotool', 'getactivewindow'], { stdout: 'pipe', stderr: 'ignore' })
  const out = (await new Response(proc.stdout).text()).trim()
  return (await proc.exited) === 0 && out ? out : undefined
}

async function downscale(path: string, maxWidth: number): Promise<void> {
  const attempts = [
    { cmd: 'magick', args: [path, '-resize', `${maxWidth}>`, path] },
    { cmd: 'convert', args: [path, '-resize', `${maxWidth}>`, path] },
    // -2 keeps the aspect ratio and an even height, which some encoders require.
    { cmd: 'ffmpeg', args: ['-y', '-i', path, '-vf', `scale='min(${maxWidth},iw)':-2`, path] },
  ]
  for (const a of attempts) {
    if (!(await commandExists(a.cmd))) continue
    const proc = Bun.spawn([a.cmd, ...a.args], { stdout: 'ignore', stderr: 'ignore' })
    if ((await proc.exited) === 0) return
  }
  log.debug('screenshot', 'No image resizer found (magick/convert/ffmpeg); sending full size')
}

async function commandExists(cmd: string): Promise<boolean> {
  const proc = Bun.spawn(['which', cmd], { stdout: 'ignore', stderr: 'ignore' })
  const code = await proc.exited
  return code === 0
}

async function captureScreenshot(params: ScreenshotParams): Promise<string> {
  const tmpPath = join(tmpdir(), `egirl-screenshot-${Date.now()}.png`)

  // Try available screenshot tools in order of preference. `window` narrows to the focused
  // window, which is usually what a question about "the terminal" or "that error" means -- and
  // it drops most of the pixels, so it is cheaper as well as more relevant.
  // maim needs a window id, which means asking xdotool first -- Bun.spawn takes an argv array and
  // runs no shell, so a `$(...)` substitution here would be passed to maim as a literal string.
  const activeWindow = params.window ? await focusedWindowId() : undefined

  const tools = params.window
    ? [
        { cmd: 'scrot', args: ['-u', tmpPath] },
        ...(activeWindow ? [{ cmd: 'maim', args: ['-i', activeWindow, tmpPath] }] : []),
        { cmd: 'gnome-screenshot', args: ['-w', '-f', tmpPath] },
      ]
    : [
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

  await downscale(tmpPath, params.maxWidth ?? DEFAULT_MAX_WIDTH)

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
        window: {
          type: 'boolean',
          description:
            'Capture only the focused window instead of the whole screen. Prefer this when the ' +
            'question is about one application.',
        },
        maxWidth: {
          type: 'number',
          description: `Downscale so the width is at most this many pixels (default ${DEFAULT_MAX_WIDTH}).`,
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
      const message = errorMessage(error)
      return {
        success: false,
        output: `Screenshot failed: ${message}`,
      }
    }
  },
}
