const readline = require('node:readline')
const pty = require('node-pty')

const [, , cwd, encodedArgs] = process.argv

if (!cwd || !encodedArgs) {
  console.log(JSON.stringify({ type: 'exit', exitCode: 1, error: 'Usage: codex-pty-runner <cwd> <args-base64>' }))
  process.exit(1)
}

let args
try {
  args = JSON.parse(Buffer.from(encodedArgs, 'base64').toString('utf8'))
} catch (error) {
  console.log(JSON.stringify({ type: 'exit', exitCode: 1, error: `Invalid args: ${error.message}` }))
  process.exit(1)
}

// Overridable so the flush behaviour below can be tested without a real codex install.
const CODEX_BIN = process.env.EGIRL_CODEX_BIN || (process.platform === 'win32' ? 'codex.exe' : 'codex')

const proc = pty.spawn(CODEX_BIN, args, {
  name: 'xterm-256color',
  cols: 100,
  rows: 30,
  cwd,
  env: {
    ...process.env,
    TERM: 'xterm-256color',
    NO_COLOR: '1',
  },
})

function send(event) {
  console.log(JSON.stringify(event))
}

const rl = readline.createInterface({ input: process.stdin })

/**
 * Exit without throwing away what codex said.
 *
 * `console.log` to a pipe is asynchronous, and the parent always gives this process piped stdio.
 * The previous version called `process.exit()` directly inside `onExit`, which discards whatever
 * is still queued -- so any codex run that finished quickly arrived at the parent as a clean exit
 * with an empty transcript.
 *
 * That is not a cosmetic loss. The parent treats an empty transcript as "produced no output" and
 * reports a working directory problem, so the actual reason (a rejected flag, a failed login, a
 * usage error) was destroyed by the reporting path. Observed live: codex printed a usage error to
 * the pty and the parent received zero bytes.
 *
 * Setting `exitCode` and releasing stdin lets the queue drain and the process end on its own. The
 * timer is a backstop for a parent that has stopped reading, and is unref'd so it never keeps an
 * otherwise-finished process alive.
 */
function shutdown(code) {
  rl.close()
  process.stdin.pause()
  process.exitCode = code
  // ConPTY can keep native handles alive after onExit. Flush queued output before exiting.
  process.stdout.write('', () => process.exit(code))
  const forced = setTimeout(() => process.exit(code), 5000)
  if (typeof forced.unref === 'function') forced.unref()
}

proc.onData((data) => {
  send({ type: 'data', data })
})

proc.onExit(({ exitCode, signal }) => {
  send({ type: 'exit', exitCode, signal })
  shutdown(exitCode ?? 0)
})

rl.on('line', (line) => {
  try {
    const event = JSON.parse(line)
    if (event.type === 'input' && typeof event.data === 'string') {
      proc.write(event.data)
    } else if (event.type === 'kill') {
      proc.kill()
    }
  } catch (error) {
    send({ type: 'error', error: error.message })
  }
})
