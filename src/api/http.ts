export type RouteHandler = (req: Request, params: Record<string, string>) => Promise<Response>

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export function error(message: string, status = 400): Response {
  return json({ error: message }, status)
}

export async function parseBody(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return null
  }
}
