/**
 * Shared plumbing for the serverless functions.
 *
 * Vercel can invoke a Node function either with web objects (Request in,
 * Response out) or with the older Node pair (req, res) — and this project gets
 * the older one. A handler written for the web signature does not fail loudly
 * under it; it fails in two confusing ways:
 *
 *   - returning a Response writes nothing to `res`, so the request hangs until
 *     the gateway gives up — a 504, and a blank page at the endpoint
 *   - `req.json()` and `req.headers.get()` do not exist on a Node request, so
 *     the first one called throws and the platform answers with its own HTML
 *     error page — a 500 with no JSON body for the app to read
 *
 * That cost a day. It lives here, once, so a second endpoint cannot repeat it.
 * `_` prefixes the filename so Vercel does not route it.
 */

export type NodeResponse = {
  statusCode: number
  setHeader: (k: string, v: string) => void
  end: (body?: string) => void
}

export type NodeRequest = {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
  body?: unknown
}

export function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** The body as text, whether the platform parsed it for us or did not. */
export function rawBody(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return body
  if (body instanceof Uint8Array) return new TextDecoder().decode(body)
  return JSON.stringify(body)
}

export function toWebRequest(req: NodeRequest, fallbackPath: string): Request {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers ?? {})) {
    if (typeof value === 'string') headers.set(key, value)
    else if (Array.isArray(value)) headers.set(key, value.join(', '))
  }

  // Vercel has already parsed a JSON body into req.body by this point, so it
  // is re-serialised rather than read from the stream, which is consumed.
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  return new Request(`https://local${req.url ?? fallbackPath}`, {
    method: req.method ?? 'GET',
    headers,
    body: hasBody ? rawBody(req.body) : undefined,
  })
}

/**
 * Wraps a web-style handler so it works under either calling convention, and
 * so nothing thrown inside reaches the platform's error page — an HTML 500 is
 * unreadable to the app, which can then only report the status number.
 */
export function makeHandler(
  respond: (req: Request) => Promise<Response>,
  fallbackPath: string,
) {
  const guarded = async (req: Request): Promise<Response> => {
    try {
      return await respond(req)
    } catch (err) {
      return json(
        {
          error: `Request crashed: ${err instanceof Error ? err.message : String(err)}`,
        },
        500,
      )
    }
  }

  return async function handler(
    req: Request | NodeRequest,
    res?: NodeResponse,
  ): Promise<Response | void> {
    // Web signature: nothing to translate.
    if (!res || typeof res.setHeader !== 'function') {
      return guarded(req as Request)
    }

    const response = await guarded(toWebRequest(req as NodeRequest, fallbackPath))
    res.statusCode = response.status
    response.headers.forEach((value, key) => res.setHeader(key, value))
    res.end(await response.text())
  }
}

// ---------------------------------------------------------------------------
// Who is allowed to call these
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
const SUPABASE_KEY =
  process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY

/**
 * The site is public, so without a check these endpoints are a free model
 * proxy billed to us. The check is the Supabase access token the app already
 * holds: the caller sends it, we ask Supabase whose it is, and refuse if the
 * answer is nobody.
 *
 * A shared secret would have been easier and worthless — one shipped in a
 * public browser bundle is readable by whoever reads the bundle.
 */
export const authConfigured = Boolean(SUPABASE_URL && SUPABASE_KEY)

export async function callerId(req: Request): Promise<string | null> {
  const header = req.headers.get('authorization') ?? ''
  const token = header.toLowerCase().startsWith('bearer ')
    ? header.slice(7).trim()
    : ''
  if (!token) return null

  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: SUPABASE_KEY as string,
        authorization: `Bearer ${token}`,
      },
    })
    if (!res.ok) return null
    const user = (await res.json()) as { id?: string }
    return user.id ?? null
  } catch {
    return null
  }
}

/**
 * A ceiling on how much one account can spend in an hour, per endpoint. This
 * is per server instance rather than global, so it is a brake and not a
 * guarantee — the guarantee is a spend cap in the provider's console.
 */
export function makeLimiter(hourlyLimit: number) {
  const WINDOW_MS = 60 * 60 * 1000
  const recent = new Map<string, number[]>()
  return function overLimit(userId: string): boolean {
    const now = Date.now()
    const hits = (recent.get(userId) ?? []).filter((t) => now - t < WINDOW_MS)
    hits.push(now)
    recent.set(userId, hits)
    return hits.length > hourlyLimit
  }
}
