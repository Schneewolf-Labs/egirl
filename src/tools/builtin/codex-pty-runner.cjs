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

const proc = pty.spawn('codex', args, {
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

proc.onData((data) => {
  send({ type: 'data', data })
})

proc.onExit(({ exitCode, signal }) => {
  send({ type: 'exit', exitCode, signal })
  process.exit(exitCode ?? 0)
})

const rl = readline.createInterface({ input: process.stdin })
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
