import { isAbsolute, resolve } from 'path'
import { errorMessage } from '../../util/errors'
import type { ProcessRegistry, ProcessSnapshot } from '../process-registry'
import type { Tool, ToolResult } from '../types'

function resolveDir(workingDir: unknown, cwd: string): string {
  if (typeof workingDir !== 'string' || workingDir.length === 0) return cwd
  return isAbsolute(workingDir) ? workingDir : resolve(cwd, workingDir)
}

function summarize(p: ProcessSnapshot): string {
  const ageS = ((Date.now() - p.startedAt) / 1000).toFixed(0)
  const ended =
    p.status === 'exited' || p.status === 'killed' || p.status === 'failed'
      ? ` exit=${p.exitCode ?? p.signal ?? '?'}`
      : ''
  const cmd = p.command.length > 80 ? `${p.command.slice(0, 77)}...` : p.command
  const label = p.label ? ` "${p.label}"` : ''
  return `${p.id}${label} [${p.status}${ended}] pid=${p.pid} age=${ageS}s lines=${p.stdoutLines}/${p.stderrLines}\n  $ ${cmd}\n  cwd: ${p.cwd}`
}

export function createProcessTools(registry: ProcessRegistry): {
  processStartTool: Tool
  processListTool: Tool
  processOutputTool: Tool
  processSendInputTool: Tool
  processStopTool: Tool
} {
  const processStartTool: Tool = {
    definition: {
      name: 'process_start',
      description: [
        'Start a long-running shell process in the background and return its process id.',
        'Use this for dev servers, watchers, log tails, REPLs — anything you want to keep running across turns.',
        'Output is captured to a ring buffer; read it with process_output. Stop with process_stop.',
        'For one-shot synchronous commands, use execute_command instead.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to start' },
          working_dir: {
            type: 'string',
            description: 'Working directory (defaults to cwd)',
          },
          label: { type: 'string', description: 'Optional human label for this process' },
        },
        required: ['command'],
      },
    },
    async execute(params: Record<string, unknown>, cwd: string): Promise<ToolResult> {
      const command = params.command as string | undefined
      if (!command) return { success: false, output: 'command is required' }
      try {
        const snap = registry.start({
          command,
          cwd: resolveDir(params.working_dir, cwd),
          label: typeof params.label === 'string' ? params.label : undefined,
        })
        return { success: true, output: `Started:\n${summarize(snap)}` }
      } catch (err) {
        const msg = errorMessage(err)
        return { success: false, output: `Failed to start process: ${msg}` }
      }
    },
  }

  const processListTool: Tool = {
    definition: {
      name: 'process_list',
      description:
        'List background processes started via process_start, including recently exited ones.',
      parameters: { type: 'object', properties: {} },
    },
    async execute(): Promise<ToolResult> {
      const procs = registry.list()
      if (procs.length === 0) return { success: true, output: 'No background processes.' }
      return { success: true, output: procs.map(summarize).join('\n\n') }
    },
  }

  const processOutputTool: Tool = {
    definition: {
      name: 'process_output',
      description: [
        'Read captured stdout/stderr from a backgrounded process.',
        'Pass since_line (from a previous next_line value) to fetch only new output.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Process id from process_start/process_list' },
          stream: {
            type: 'string',
            enum: ['stdout', 'stderr', 'both'],
            description: 'Which stream to read (default: both)',
          },
          since_line: {
            type: 'number',
            description: 'Only return lines after this index (use next_line from previous call)',
          },
          tail_lines: {
            type: 'number',
            description: 'Cap returned lines to last N (default: no cap)',
          },
        },
        required: ['id'],
      },
    },
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const id = params.id as string | undefined
      if (!id) return { success: false, output: 'id is required' }
      const out = registry.output(id, {
        stream: params.stream as 'stdout' | 'stderr' | 'both' | undefined,
        sinceLine: typeof params.since_line === 'number' ? params.since_line : undefined,
        tailLines: typeof params.tail_lines === 'number' ? params.tail_lines : undefined,
      })
      if (!out) return { success: false, output: `No process with id ${id}` }

      const stream = (params.stream as string | undefined) ?? 'both'
      const sections: string[] = [`status: ${out.status}`]
      if (stream !== 'stderr') {
        sections.push(
          `stdout (next_line=${out.stdoutNextLine}):\n${out.stdout.join('\n') || '(empty)'}`,
        )
      }
      if (stream !== 'stdout') {
        sections.push(
          `stderr (next_line=${out.stderrNextLine}):\n${out.stderr.join('\n') || '(empty)'}`,
        )
      }
      return { success: true, output: sections.join('\n\n') }
    },
  }

  const processSendInputTool: Tool = {
    definition: {
      name: 'process_send_input',
      description:
        'Send a line of input to a backgrounded process via stdin. Appends a newline by default.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Process id' },
          input: { type: 'string', description: 'Text to write to stdin' },
          newline: {
            type: 'boolean',
            description: 'Append a trailing newline (default: true)',
          },
        },
        required: ['id', 'input'],
      },
    },
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const id = params.id as string | undefined
      const input = params.input as string | undefined
      if (!id || input === undefined) {
        return { success: false, output: 'id and input are required' }
      }
      const ok = registry.sendInput(id, input, {
        newline: typeof params.newline === 'boolean' ? params.newline : undefined,
      })
      return ok
        ? { success: true, output: `Sent ${input.length} bytes to ${id}` }
        : { success: false, output: `Process ${id} is not running or has no writable stdin` }
    },
  }

  const processStopTool: Tool = {
    definition: {
      name: 'process_stop',
      description:
        'Stop a backgrounded process. Sends SIGTERM, then SIGKILL if it does not exit within timeout.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Process id' },
          signal: {
            type: 'string',
            description: 'Signal to send first (default: SIGTERM)',
          },
          timeout_ms: {
            type: 'number',
            description: 'Grace period before SIGKILL (default: 5000)',
          },
        },
        required: ['id'],
      },
    },
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const id = params.id as string | undefined
      if (!id) return { success: false, output: 'id is required' }
      const result = await registry.stop(id, {
        signal: typeof params.signal === 'string' ? (params.signal as NodeJS.Signals) : undefined,
        timeoutMs: typeof params.timeout_ms === 'number' ? params.timeout_ms : undefined,
      })
      return {
        success: result.stopped,
        output: result.stopped
          ? `Process ${id} stopped (status: ${result.status})`
          : `Process ${id} did not stop`,
      }
    },
  }

  return {
    processStartTool,
    processListTool,
    processOutputTool,
    processSendInputTool,
    processStopTool,
  }
}
