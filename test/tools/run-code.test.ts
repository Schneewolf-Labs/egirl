import { describe, expect, test } from 'bun:test'
import type { RuntimeConfig } from '../../src/config'
import { createDefaultToolExecutor } from '../../src/tools'
import {
  createRunCodeTool,
  formatResult,
  readyLanguages,
  sandboxUnavailable,
} from '../../src/tools/builtin/run-code'
import { bwrapArgs, MAX_OUTPUT } from '../../src/tools/builtin/run-code/sandbox'

const CONFIG = { languages: ['python'], timeoutMs: 3000, memoryMb: 256, binaries: {} }
const canSandbox = sandboxUnavailable() === undefined

function run(code: string, language?: string) {
  const tool = createRunCodeTool(CONFIG, readyLanguages(CONFIG))
  return tool.execute({ code, ...(language ? { language } : {}) }, '/')
}

describe('run_code result formatting', () => {
  test('a clean exit returns stdout', () => {
    expect(
      formatResult(
        { stdout: '42\n', stderr: '', exitCode: 0, isTimedOut: false, isTruncated: false },
        3000,
      ),
    ).toEqual({ success: true, output: '42' })
  })

  test('a failing program says so even when it printed', () => {
    const r = formatResult(
      {
        stdout: 'partial',
        stderr: 'Traceback',
        exitCode: 1,
        isTimedOut: false,
        isTruncated: false,
      },
      3000,
    )
    expect(r.success).toBe(false)
    expect(r.output).toContain('partial')
    expect(r.output).toContain('Traceback')
    expect(r.output).toContain('[exit code 1]')
  })

  test('a timeout names the limit', () => {
    const r = formatResult({ stdout: '', stderr: '', isTimedOut: true, isTruncated: false }, 3000)
    expect(r.success).toBe(false)
    expect(r.output).toContain('3s time limit')
  })

  test('silence asks for a print', () => {
    const r = formatResult(
      { stdout: '', stderr: '', exitCode: 0, isTimedOut: false, isTruncated: false },
      3000,
    )
    expect(r.output).toContain('print the result')
  })
})

describe('run_code sandbox arguments', () => {
  const base = {
    args: (s: string) => [s],
    extension: '.x',
    readPaths: [],
    code: '',
    timeoutMs: 1,
    memoryMb: 1,
  }

  test('every namespace is unshared and the environment cleared', () => {
    const argv = bwrapArgs({ ...base, binaryPath: '/usr/bin/python3' }, '/tmp/w', '/work/main.x')
    expect(argv).toContain('--unshare-all')
    expect(argv).toContain('--clearenv')
    expect(argv).not.toContain('/home')
  })

  test('an interpreter outside /usr gets its own directory, read-only', () => {
    const argv = bwrapArgs(
      { ...base, binaryPath: '/opt/lang/bin/lang', readPaths: ['/opt/lang/lib'] },
      '/tmp/w',
      '/work/main.x',
    )
    const joined = argv.join(' ')
    expect(joined).toContain('--ro-bind-try /opt/lang/bin /opt/lang/bin')
    expect(joined).toContain('--ro-bind-try /opt/lang/lib /opt/lang/lib')
  })
})

describe('run_code languages', () => {
  test('an unknown language is skipped, not registered', () => {
    expect(readyLanguages({ ...CONFIG, languages: ['cobol'] })).toEqual([])
  })

  test('a missing interpreter is skipped', () => {
    expect(readyLanguages({ ...CONFIG, binaries: { python: '/nonexistent/python3' } })).toEqual([])
  })

  test('the flag with no runnable language registers nothing', () => {
    const cfg = {
      tools: { runCode: true },
      runCode: { ...CONFIG, languages: ['cobol'] },
    } as unknown as RuntimeConfig
    expect(createDefaultToolExecutor(cfg).listTools()).not.toContain('run_code')
  })
})

describe.skipIf(!canSandbox)('run_code in the sandbox', () => {
  test('computes and prints', async () => {
    const r = await run('print(sum(range(1, 101)))')
    expect(r).toEqual({ success: true, output: '5050' })
  })

  test('has no network', async () => {
    const r = await run('import socket\nsocket.create_connection(("1.1.1.1", 80), timeout=2)')
    expect(r.success).toBe(false)
  })

  test('cannot see the host home directories', async () => {
    const r = await run('import os\nprint(os.path.exists("/home"), os.path.exists("/root"))')
    expect(r.output).toBe('False False')
  })

  test('cannot write outside its working directory', async () => {
    const r = await run('open("/work/ok", "w").write("x")\nopen("/usr/nope", "w")')
    expect(r.success).toBe(false)
    expect(r.output).toContain('Read-only file system')
  })

  test('is killed at the time limit', async () => {
    const r = await run('while True: pass')
    expect(r.success).toBe(false)
    expect(r.output).toContain('time limit')
  })

  test('cannot allocate past the memory limit', async () => {
    const r = await run('x = bytearray(1024 ** 3)')
    expect(r.output).toContain('MemoryError')
  })

  test('caps output', async () => {
    const r = await run(`print("x" * ${MAX_OUTPUT * 2})`)
    expect(r.output).toContain('[output truncated]')
    expect(r.output.length).toBeLessThan(MAX_OUTPUT + 200)
  })

  test.skipIf(!Bun.which('hemlock'))('runs hemlock with its stdlib', async () => {
    const cfg = { ...CONFIG, languages: ['python', 'hemlock'] }
    const tool = createRunCodeTool(cfg, readyLanguages(cfg))
    const r = await tool.execute(
      {
        language: 'hemlock',
        code: 'import { time_ms } from "@stdlib/time";\nlet t = 0;\nfor (let i = 1; i <= 100; i = i + 1) { t = t + i; }\nprint(t);\nprint(time_ms() > 0);',
      },
      '/',
    )
    expect(r).toEqual({ success: true, output: '5050\ntrue' })
  })

  test('registers when the flag is on', () => {
    const cfg = { tools: { runCode: true }, runCode: CONFIG } as unknown as RuntimeConfig
    expect(createDefaultToolExecutor(cfg).listTools()).toContain('run_code')
  })
})
