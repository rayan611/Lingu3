/**
 * Vercel serverless function: writes a short text out of words the reader
 * already knows.
 *
 * Separate from /api/expand and with its own rate cap, because the two cost
 * very different amounts and are abused in different ways: expansion is one
 * small structured answer, a story is free prose and a much larger output.
 *
 * The model is given the vocabulary and told to stay inside it. It will not
 * fully obey — they never do on a constrained word list — so the client
 * verifies coverage against the real vocabulary afterwards and shows the
 * actual number. Nothing here is trusted on that point.
 */
const GEMINI_KEY = process.env.GEMINI_API_KEY
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY
const PROVIDER: 'gemini' | 'anthropic' = GEMINI_KEY ? 'gemini' : 'anthropic'

const MODEL =
  process.env.LINGUA_STORY_MODEL ??
  process.env.LINGUA_MODEL ??
  (PROVIDER === 'gemini' ? 'gemini-3.8-flash' : 'claude-haiku-5-5')

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const GEMINI_URL = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`

export const maxDuration = 60
const UPSTREAM_TIMEOUT_MS = 50_000

/** Lower than expansion's 80: a story is a much bigger answer. */
const overLimit = makeLimiter(20)

const LANG_NAMES: Record<string, string> = {
  fa: 'Persian (Farsi)',
  en: 'English',
  sv: 'Swedish',
  de: 'German',
  es: 'Spanish',
  ru: 'Russian',
}

const GENRES: Record<string, string> = {
  fun: 'a light, slightly funny everyday scene',
  fact: 'a short piece of true popular science or history',
  social: 'an everyday social situation — a shop, a neighbour, a queue',
  dialogue: 'a short dialogue between two named people, with speaker labels',
  joke: 'a short joke or anecdote with a punchline',
}

const LENGTHS: Record<string, { sentences: string; words: number }> = {
  short: { sentences: '3 to 4 sentences', words: 60 },
  long: { sentences: '8 to 12 sentences', words: 180 },
}

function buildPrompt(opts: {
  lang: string
  nativeLang: string
  words: string[]
  genre: string
  length: string
  unknownShare: number
}) {
  const { lang, nativeLang, words, genre, length, unknownShare } = opts
  const target = LANG_NAMES[lang] ?? lang
  const native = LANG_NAMES[nativeLang] ?? nativeLang
  const len = LENGTHS[length] ?? LENGTHS.short
  const genreText = GENRES[genre] ?? GENRES.fun
  const allowed = Math.max(0, Math.round(words.length * unknownShare))

  return `Write a short text in ${target} for a language learner, using the
vocabulary they already know.

THE VOCABULARY — these are the words they have studied. Build the text out of
these:

${words.join(', ')}

RULES

1. Length: ${len.sentences}. Write ${genreText}.

2. Function words are free. Articles, pronouns, prepositions, conjunctions,
   auxiliaries, numbers and the most ordinary verbs of a beginner's
   ${target} may be used whether or not they appear above — a text built only
   from content words is not a text.

3. Beyond those, introduce at most ${allowed} new content words. Fewer is
   better. A text the reader can follow is the goal; a text that shows off
   vocabulary is not.

4. Inflect freely. The vocabulary is given in dictionary form; use whatever
   case, tense, number or gender the sentence needs. That is not introducing a
   new word.

5. Natural ${target} first. If a word above would make the sentence stilted,
   leave it out. Do not force every word in.

Return:
  - "title": three or four words, in ${target}
  - "body": the text itself, in ${target}, nothing else — no translation, no
    notes, no vocabulary list
  - "glossary": every content word in the body that is NOT in the vocabulary
    above, each with a short meaning in ${native}. Leave out function words.
    If there are none, return an empty list.`
}

const TOOL = {
  name: 'write_text',
  description: 'Return the generated text and its glossary.',
  input_schema: {
    type: 'object' as const,
    properties: {
      title: { type: 'string' },
      body: { type: 'string' },
      glossary: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            word: { type: 'string' },
            meaning: { type: 'string' },
          },
          required: ['word', 'meaning'],
        },
      },
    },
    required: ['title', 'body'],
  },
}

const GEMINI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    body: { type: 'STRING' },
    glossary: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { word: { type: 'STRING' }, meaning: { type: 'STRING' } },
        required: ['word', 'meaning'],
      },
    },
  },
  required: ['title', 'body'],
}

// ---------------------------------------------------------------------------
// Two calling conventions, one function
//
// Vercel can invoke a Node function either with web objects (Request in,
// Response out) or with the older Node pair (req, res) — and this project gets
// the older one. A handler written for the web signature does not fail loudly
// under it; it hangs until the gateway gives up (504, blank page), or throws on
// req.json() and is answered with the platform's own HTML page (500, no JSON
// for the app to read). That cost a day; see the build log.
//
// This block is duplicated in every file under api/ ON PURPOSE. It was briefly
// factored out into api/_http.ts, which broke production immediately:
// package.json is "type": "module", so Node's ESM resolver requires a file
// extension on a relative import. `./_http` resolves under tsx locally and
// throws ERR_MODULE_NOT_FOUND on Vercel at import time — which surfaces as the
// same unreadable HTML 500 the convention bug did. Sixty duplicated lines with
// no import is worth more here than one shared copy that can take the whole
// endpoint down on a resolution rule that does not show up in any local check.
// ---------------------------------------------------------------------------

type NodeResponse = {
  statusCode: number
  setHeader: (k: string, v: string) => void
  end: (body?: string) => void
}

type NodeRequest = {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
  body?: unknown
}

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** The body as text, whether the platform parsed it for us or did not. */
function rawBody(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return body
  if (body instanceof Uint8Array) return new TextDecoder().decode(body)
  return JSON.stringify(body)
}

function toWebRequest(req: NodeRequest, fallbackPath: string): Request {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers ?? {})) {
    if (typeof value === 'string') headers.set(key, value)
    else if (Array.isArray(value)) headers.set(key, value.join(', '))
  }
  // Vercel has already parsed a JSON body into req.body by this point, so it is
  // re-serialised rather than read from the stream, which is consumed.
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  return new Request(`https://local${req.url ?? fallbackPath}`, {
    method: req.method ?? 'GET',
    headers,
    body: hasBody ? rawBody(req.body) : undefined,
  })
}

/**
 * Wraps a web-style handler so it works under either convention, and so
 * nothing thrown inside reaches the platform's error page — an HTML 500 is
 * unreadable to the app, which can then only report the status number.
 */
function makeHandler(
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
// Who is allowed to call this
//
// The site is public, so without a check this endpoint is a free model proxy
// billed to us. The check is the Supabase access token the app already holds:
// the caller sends it, we ask Supabase whose it is, and refuse if the answer is
// nobody. A shared secret would have been easier and worthless — one shipped in
// a public browser bundle is readable by whoever reads the bundle.
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
const SUPABASE_KEY =
  process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY

const authConfigured = Boolean(SUPABASE_URL && SUPABASE_KEY)

async function callerId(req: Request): Promise<string | null> {
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
 * A ceiling on how much one account can spend in an hour. Per server instance
 * rather than global, so it is a brake and not a guarantee — the guarantee is a
 * spend cap in the provider's console.
 */
function makeLimiter(hourlyLimit: number) {
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

export default makeHandler(respond, '/api/story')

async function respond(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  if (authConfigured) {
    const userId = await callerId(req)
    if (!userId) return json({ error: 'Sign in before writing a text.' }, 401)
    if (overLimit(userId)) {
      return json({ error: 'Too many texts in one hour. Try again later.' }, 429)
    }
  }

  const apiKey = PROVIDER === 'gemini' ? GEMINI_KEY : ANTHROPIC_KEY
  if (!apiKey) {
    return json(
      {
        error:
          'No model key is configured on the server. Set GEMINI_API_KEY or ANTHROPIC_API_KEY.',
      },
      500,
    )
  }

  let body: {
    lang?: string
    nativeLang?: string
    words?: string[]
    genre?: string
    length?: string
    unknownShare?: number
  }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400)
  }

  const lang = body.lang ?? 'sv'
  const nativeLang = body.nativeLang ?? 'fa'
  // Capped: a prompt carrying two thousand words costs more than the text is
  // worth, and the newest words are the ones worth practising.
  const words = (Array.isArray(body.words) ? body.words : [])
    .map((w) => String(w).trim())
    .filter(Boolean)
    .slice(0, 400)

  if (words.length < 5) {
    return json(
      { error: 'Not enough words yet. Add a few more and try again.' },
      400,
    )
  }

  const prompt = buildPrompt({
    lang,
    nativeLang,
    words,
    genre: body.genre ?? 'fun',
    length: body.length ?? 'short',
    unknownShare: Math.min(0.3, Math.max(0, Number(body.unknownShare) || 0.05)),
  })

  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), UPSTREAM_TIMEOUT_MS)

  let upstream: Response
  try {
    upstream =
      PROVIDER === 'gemini'
        ? await callGemini(prompt, apiKey, abort.signal)
        : await callAnthropic(prompt, apiKey, abort.signal)
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return json({ error: 'The model took too long. Try again.' }, 504)
    }
    return json({ error: `Could not reach the model: ${String(err)}` }, 502)
  } finally {
    clearTimeout(timer)
  }

  if (!upstream.ok) {
    const detail = await upstream.text()
    return json(
      {
        error: `Model request failed (${upstream.status}).`,
        detail: detail.slice(0, 500),
      },
      upstream.status === 429 ? 429 : 502,
    )
  }

  let story: unknown
  try {
    story =
      PROVIDER === 'gemini'
        ? readGemini(await upstream.json())
        : readAnthropic(await upstream.json())
  } catch (err) {
    return json({ error: `Could not read the answer: ${String(err)}` }, 502)
  }

  if (!story) return json({ error: 'Model did not return a usable text.' }, 502)
  return json(story, 200)
}

function callAnthropic(prompt: string, key: string, signal: AbortSignal) {
  return fetch(ANTHROPIC_URL, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2048,
      // Not zero, unlike expansion: the same six words should not produce the
      // same story every morning.
      temperature: 0.8,
      tools: [TOOL],
      tool_choice: { type: 'tool', name: 'write_text' },
      messages: [{ role: 'user', content: prompt }],
    }),
  })
}

export function readAnthropic(data: unknown): unknown {
  const content = (
    data as { content?: Array<{ type: string; name?: string; input?: unknown }> }
  ).content
  const block = content?.find((c) => c.type === 'tool_use' && c.name === 'write_text')
  return block?.input ?? null
}

function callGemini(prompt: string, key: string, signal: AbortSignal) {
  return fetch(`${GEMINI_URL(MODEL)}?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.8,
        maxOutputTokens: 2048,
        responseMimeType: 'application/json',
        responseSchema: GEMINI_SCHEMA,
      },
    }),
  })
}

export function readGemini(data: unknown): unknown {
  const text = (
    data as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    }
  ).candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) return null
  return JSON.parse(text)
}
