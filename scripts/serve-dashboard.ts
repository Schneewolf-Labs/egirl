/** Serve the dashboard static files standalone — for development or pointing at a remote egirl instance */
import { join } from 'path'

const STATIC_DIR = join(import.meta.dir, '../static')
const port = parseInt(process.env.PORT || '4000')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
}

Bun.serve({
  port,
  fetch(req) {
    const path = new URL(req.url).pathname
    const file = path === '/' ? 'dashboard.html' : path.replace(/^\/static\//, '')
    const ext = file.substring(file.lastIndexOf('.'))
    const contentType = MIME[ext]
    if (!contentType) return new Response('Not found', { status: 404 })
    return new Response(Bun.file(join(STATIC_DIR, file)), {
      headers: { 'Content-Type': contentType },
    })
  },
})

console.log(`Dashboard at http://localhost:${port}`)
console.log(`Point at a running egirl: http://localhost:${port}?api=http://localhost:3000`)
