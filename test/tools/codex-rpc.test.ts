import { describe, expect, test } from 'bun:test'
import { runCodexSession } from '../../src/tools/builtin/code-agent/codex'
import { connectCodex } from '../../src/tools/builtin/code-agent/codex-rpc'

const fake = `
const readline = require('node:readline');
const mode = process.argv[1];
readline.createInterface({input: process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (mode === 'hang') return;
  if (mode === 'malformed') { process.stdout.write('not json\\n'); return; }
  if (mode === 'exit') { process.exit(0); }
  if (mode === 'error') { process.stdout.write(JSON.stringify({id:m.id,error:{code:-1,message:'fixture error'}})+'\\n'); return; }
  const bytes = Buffer.from(JSON.stringify({id:m.id,result:{text:'héllo 🌙'}})+'\\n');
  const split = bytes.indexOf(0xf0) + 1;
  process.stdout.write(bytes.subarray(0,split));
  setTimeout(() => process.stdout.write(bytes.subarray(split)), 10);
});
`

describe('Codex stdio transport', () => {
  test('reassembles UTF-8 and correlates RPC responses', async () => {
    const failures: Error[] = []
    const rpc = connectCodex(
      process.cwd(),
      {
        notification() {},
        async request() {},
        failure(e) {
          failures.push(e)
        },
      },
      process.execPath,
      ['-e', fake, 'echo'],
    )
    try {
      // Sequential writes keep the fixture's intentionally split frames valid.
      expect(await rpc.request('first', {})).toEqual({ text: 'héllo 🌙' })
      expect(await rpc.request('second', {})).toEqual({ text: 'héllo 🌙' })
      expect(failures).toHaveLength(0)
    } finally {
      await rpc.close(true)
    }
  })
  test('RPC errors reject the matching request', async () => {
    const rpc = connectCodex(
      process.cwd(),
      { notification() {}, async request() {}, failure() {} },
      process.execPath,
      ['-e', fake, 'error'],
    )
    try {
      await expect(rpc.request('first', {})).rejects.toThrow('fixture error')
    } finally {
      await rpc.close(true)
    }
  })
  test.each([
    'malformed',
    'exit',
    'hang',
  ])('%s during initialization fails without hanging', async (mode) => {
    const start = Date.now()
    const result = await runCodexSession(
      { permissionMode: 'default', workingDir: process.cwd(), timeoutMs: 400 },
      'test',
      process.cwd(),
      (cwd, events) => connectCodex(cwd, events, process.execPath, ['-e', fake, mode]),
    )
    expect(result.success).toBe(false)
    expect(Date.now() - start).toBeLessThan(5000)
  })
  test('missing executable resolves as failure', async () => {
    const result = await runCodexSession(
      { permissionMode: 'default', workingDir: process.cwd(), timeoutMs: 400 },
      'test',
      process.cwd(),
      (cwd, events) => connectCodex(cwd, events, 'missing-codex-test-binary'),
    )
    expect(result.success).toBe(false)
    expect(result.output).toMatch(/ENOENT|not found/)
  })
})
