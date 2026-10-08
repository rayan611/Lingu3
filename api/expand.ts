/**
 * Vercel serverless function: expands one word into every selected language in
 * a single Claude call.
 *
 * One call per word rather than one per language, for three reasons: it is
 * cheaper, the example sentences come out genuinely parallel (the same
 * situation rendered in each language, which is what makes them worth
 * comparing side by side), and the part of speech is decided once instead of
 * three times with a chance of disagreeing.
 *
 * The API key lives here and never reaches the browser.
 */

// Haiku is the default: this task is short, structured and runs at low volume,
// so the cheapest model is the right starting point. If genders or auxiliary
// verbs start coming back wrong, set LINGUA_MODEL to a stronger model — the
// cost difference at a few dozen words a day is small, and a wrong der/die/das
// gets drilled into you by the scheduler for months.
/**
 * Two providers, chosen by which key is configured. Gemini wins when its key
 * is present, because setting it is a deliberate act; Anthropic is the
 * fallback. Nothing downstream knows or cares which one answered — both are
 * normalised to the same shape before they leave this file, and the database,
 * the scheduler and the review screen see identical entries either way.
 */
const GEMINI_KEY = process.env.GEMINI_API_KEY
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY
const PROVIDER: 'gemini' | 'anthropic' = GEMINI_KEY ? 'gemini' : 'anthropic'

const MODEL =
  process.env.LINGUA_MODEL ??
  (PROVIDER === 'gemini' ? 'gemini-2.5-flash' : 'claude-haiku-5-5')

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const GEMINI_URL = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`

/**
 * Vercel kills a function at 10 seconds by default, and this one spends nearly
 * all its time waiting on a single model call that writes four languages of
 * structured output. That is comfortably more than ten seconds, so every
 * request died as a 504 before the model had finished — the word saved, the
 * expansion never arrived.
 *
 * 60s is the Hobby-plan ceiling. The call does not normally take anywhere near
 * it; the number exists so a slow one finishes instead of being executed.
 */
export const maxDuration = 60

/**
 * Abandon the upstream call a few seconds before Vercel would kill the
 * function, so a slow model returns a readable error through our own JSON
 * shape rather than a gateway page the client cannot parse.
 */
const UPSTREAM_TIMEOUT_MS = 50_000

const LANG_NAMES: Record<string, string> = {
  fa: 'Persian (Farsi)',
  en: 'English',
  sv: 'Swedish',
  de: 'German',
}

/**
 * Morphology rules, written per language on purpose. German needs an auxiliary
 * verb and a separable-prefix flag that Swedish has no equivalent for, and the
 * two gender systems are unrelated — a shared schema would quietly drop the
 * fields that matter most to a learner.
 */
const MORPHOLOGY_RULES = `
MORPHOLOGY — required fields, per language. Use exactly these key names.

Swedish (sv):
  noun -> { "kind":"noun", "gender":"en"|"ett", "definiteSingular":"...",
            "indefinitePlural":"...", "definitePlural":"..." }
  verb -> { "kind":"verb", "infinitiv":"...", "presens":"...",
            "preteritum":"...", "supinum":"...", "imperativ":"...",
            "particle":"..." (only for particle verbs, else omit) }
  anything else -> { "kind":"simple" }

German (de):
  noun -> { "kind":"noun", "gender":"der"|"die"|"das", "plural":"...",
            "genitiveSingular":"..." }
  verb -> { "kind":"verb", "infinitiv":"...", "praesens":"<3rd person sing>",
            "praeteritum":"<3rd person sing>", "partizip2":"...",
            "auxiliary":"haben"|"sein", "separable":true|false,
            "prefix":"..." (only when separable, else omit) }
  anything else -> { "kind":"simple" }

English (en):
  noun -> { "kind":"noun", "plural":"..." }
  verb -> { "kind":"verb", "base":"...", "thirdPerson":"...", "past":"...",
            "pastParticiple":"..." }
  anything else -> { "kind":"simple" }

Persian (fa):
  always -> { "kind":"simple" }

Gender and auxiliary are never optional for nouns and verbs. They are the
fields a learner most often gets wrong, so guessing is worse than useless —
if you are genuinely unsure of a form, say so in "notes" rather than
inventing one.
`.trim()

const TOOL = {
  name: 'record_word',
  description: 'Record the expanded word across all requested languages.',
  input_schema: {
    type: 'object' as const,
    properties: {
      pos: {
        type: 'string',
        enum: [
          'noun',
          'verb',
          'adjective',
          'adverb',
          'preposition',
          'phrase',
          'other',
        ],
        description: 'Part of speech of the concept as a whole.',
      },
      normalisedLemma: {
        type: 'string',
        description:
          'The input cleaned up: typo fixed, article stripped, verb put in the infinitive. Omit if the input was already clean.',
      },
      entries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            lang: { type: 'string', enum: ['fa', 'en', 'sv', 'de'] },
            headword: {
              type: 'string',
              description:
                'The word in this language. For German and Swedish nouns include the article (der Hund, en hund).',
            },
            meaning: {
              type: 'string',
              description:
                'A short gloss, under 12 words. Not a dictionary entry.',
            },
            morphology: {
              type: 'object',
              description: 'Per the morphology rules. Always include it.',
            },
            example: {
              type: 'string',
              description:
                'One natural sentence using the word, at roughly A2-B1 level.',
            },
            exampleGloss: {
              type: 'string',
              description:
                'The example rendered in the user native language.',
            },
            notes: {
              type: 'string',
              description:
                'Only when there is something genuinely worth flagging: a false friend, an irregular form, a register warning. Omit otherwise.',
            },
          },
          required: ['lang', 'headword', 'meaning', 'morphology'],
        },
      },
    },
    required: ['pos', 'entries'],
  },
}

function buildPrompt(opts: {
  lemma: string
  sourceLang: string
  nativeLang: string
  langs: string[]
  hint?: string
}) {
  const { lemma, sourceLang, nativeLang, langs, hint } = opts
  const targets = langs.map((l) => `${LANG_NAMES[l] ?? l} (${l})`).join(', ')

  return `You are building a vocabulary entry for a language learner.

The learner's native language is ${LANG_NAMES[nativeLang] ?? nativeLang} (${nativeLang}).
They entered this word in ${LANG_NAMES[sourceLang] ?? sourceLang} (${sourceLang}):

  ${lemma}
${hint ? `\nThey added this hint about which sense they mean: ${hint}\n` : ''}
Produce one entry for each of these languages: ${targets}.

${MORPHOLOGY_RULES}

EXAMPLE SENTENCES — this is the part that is easy to do badly.
Write each language's example as a natural sentence in that language, all
describing the SAME situation. Do not translate one sentence literally into
the others: a literal translation produces stilted German and unidiomatic
Swedish. The learner reads these stacked on top of each other and compares
them, so they should be recognisably the same scene said the way each
language actually says it.

SENSE — pick ONE sense, the most common everyday one, and use that sense
consistently in every language. A word with several unrelated senses should
become several separate entries, not one entry that blurs them.

Call the record_word tool. Do not write anything outside the tool call.`
}

/**
 * ---------------------------------------------------------------------------
 * Who is allowed to call this
 * ---------------------------------------------------------------------------
 *
 * The site is public, so without a check this endpoint is a free Claude proxy
 * for anyone who finds it, billed to us. The check is the Supabase access
 * token the app already holds: the caller sends it, we ask Supabase whose it
 * is, and we refuse if the answer is nobody.
 *
 * A shared secret would have been easier and worthless — a secret shipped in a
 * public browser bundle is readable by whoever reads the bundle. A token is
 * per-person, expires on its own, and costs no new environment variables,
 * since the Supabase URL and publishable key are already configured here.
 *
 * If Supabase is not configured at all (local development), the check is
 * skipped rather than locking the endpoint shut.
 */
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
      headers: { apikey: SUPABASE_KEY as string, authorization: `Bearer ${token}` },
    })
    if (!res.ok) return null
    const user = (await res.json()) as { id?: string }
    return user.id ?? null
  } catch {
    return null
  }
}

/**
 * A ceiling on how much one account can spend in an hour. This is per server
 * instance rather than global, so it is a brake and not a guarantee — the
 * guarantee is the spend cap in the Anthropic console, which lives outside
 * this code. 80/hour is far above real use (a heavy session is 30 words) and
 * far below anything that would cost real money.
 */
const HOURLY_LIMIT = 80
const WINDOW_MS = 60 * 60 * 1000
const recent = new Map<string, number[]>()

function overLimit(userId: string): boolean {
  const now = Date.now()
  const hits = (recent.get(userId) ?? []).filter((t) => now - t < WINDOW_MS)
  hits.push(now)
  recent.set(userId, hits)
  return hits.length > HOURLY_LIMIT
}

/**
 * ---------------------------------------------------------------------------
 * Two calling conventions, one function
 * ---------------------------------------------------------------------------
 *
 * This is why nothing worked. Vercel can invoke a Node function either with
 * web objects (Request in, Response out) or with the older Node pair
 * (req, res) — and this project gets the older one. A handler written for the
 * web signature does not fail loudly under it; it fails in two confusing ways:
 *
 *   - returning a Response writes nothing to `res`, so the request simply
 *     hangs until the gateway gives up — that was the 504, and the reason
 *     opening /api/expand in a browser showed a blank page
 *   - `req.json()` and `req.headers.get()` do not exist on a Node request, so
 *     the first one called throws, and Vercel answers with its own HTML error
 *     page — that was the 500, with no JSON body for the app to read, which is
 *     why the queue could only show the bare status number
 *
 * So the entry point now detects which it was handed, and the real work stays
 * in `respond`, written once against web objects.
 */
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

export default async function handler(
  req: Request | NodeRequest,
  res?: NodeResponse,
): Promise<Response | void> {
  // Web signature: nothing to translate.
  if (!res || typeof res.setHeader !== 'function') {
    return guarded(req as Request)
  }

  // Node signature: build a Request, run the same code, write the Response out.
  const response = await guarded(toWebRequest(req as NodeRequest))
  res.statusCode = response.status
  response.headers.forEach((value, key) => res.setHeader(key, value))
  res.end(await response.text())
}

function toWebRequest(req: NodeRequest): Request {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers ?? {})) {
    if (typeof value === 'string') headers.set(key, value)
    else if (Array.isArray(value)) headers.set(key, value.join(', '))
  }

  // Vercel has already parsed a JSON body into req.body by this point, so it
  // is re-serialised rather than read from the stream, which is consumed.
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  return new Request(`https://local${req.url ?? '/api/expand'}`, {
    method: req.method ?? 'GET',
    headers,
    body: hasBody ? rawBody(req.body) : undefined,
  })
}

/** The body as text, whether the platform parsed it for us or did not. */
function rawBody(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return body
  if (body instanceof Uint8Array) return new TextDecoder().decode(body)
  return JSON.stringify(body)
}

/**
 * Nothing thrown in here should ever reach the platform's error page: an HTML
 * 500 is unreadable to the app, which can only report the status number. Any
 * failure comes back as our own JSON so the queue can show what happened.
 */
async function guarded(req: Request): Promise<Response> {
  try {
    return await respond(req)
  } catch (err) {
    return json(
      { error: `Expansion crashed: ${err instanceof Error ? err.message : String(err)}` },
      500,
    )
  }
}

async function respond(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  if (authConfigured) {
    const userId = await callerId(req)
    if (!userId) {
      return json({ error: 'Sign in before adding words.' }, 401)
    }
    if (overLimit(userId)) {
      return json(
        { error: 'Too many words in one hour. Try again later.' },
        429,
      )
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
    lemma?: string
    sourceLang?: string
    nativeLang?: string
    langs?: string[]
    hint?: string
  }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400)
  }

  const lemma = (body.lemma ?? '').trim()
  const sourceLang = body.sourceLang ?? 'en'
  const nativeLang = body.nativeLang ?? 'fa'
  const langs = Array.isArray(body.langs) ? body.langs : []

  if (!lemma) return json({ error: 'lemma is required.' }, 400)
  if (lemma.length > 120) return json({ error: 'lemma is too long.' }, 400)
  if (langs.length === 0) return json({ error: 'langs is required.' }, 400)

  const prompt = buildPrompt({ lemma, sourceLang, nativeLang, langs, hint: body.hint })

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
      return json(
        { error: 'The model took too long to answer. Try "Expand now" again.' },
        504,
      )
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

  let expansion: unknown
  try {
    expansion =
      PROVIDER === 'gemini'
        ? readGemini(await upstream.json())
        : readAnthropic(await upstream.json())
  } catch (err) {
    return json(
      { error: `Could not read the model's answer: ${String(err)}` },
      502,
    )
  }

  if (!expansion) {
    return json({ error: 'Model did not return a usable result.' }, 502)
  }

  return json(expansion, 200)
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

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
      temperature: 0,
      tools: [TOOL],
      // Forcing the tool is what makes the output parseable every time
      // instead of most of the time.
      tool_choice: { type: 'tool', name: 'record_word' },
      messages: [{ role: 'user', content: prompt }],
    }),
  })
}

export function readAnthropic(data: unknown): unknown {
  const content = (data as { content?: Array<{ type: string; name?: string; input?: unknown }> })
    .content
  const block = content?.find((c) => c.type === 'tool_use' && c.name === 'record_word')
  return block?.input ?? null
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

/**
 * Gemini's structured output uses an OpenAPI subset, and that subset has no
 * way to say "an object whose shape depends on the language" — every OBJECT
 * must declare its properties up front. Morphology is exactly that: a Swedish
 * noun and a German verb share no fields.
 *
 * So morphology is requested as a JSON *string* and parsed here, before the
 * answer leaves this file. The app still receives a real object and validates
 * it against the per-language schema it already has, which is where a malformed
 * one gets dropped. Asking for a flattened one-size-fits-all object instead
 * would have thrown away der/die/das and haben/sein, which are the fields most
 * worth having.
 */
const GEMINI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    pos: {
      type: 'STRING',
      enum: ['noun', 'verb', 'adjective', 'adverb', 'preposition', 'phrase', 'other'],
    },
    normalisedLemma: { type: 'STRING' },
    entries: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          lang: { type: 'STRING', enum: ['fa', 'en', 'sv', 'de'] },
          headword: { type: 'STRING' },
          meaning: { type: 'STRING' },
          morphologyJson: {
            type: 'STRING',
            description:
              'The morphology object for this language, serialised as a JSON string, exactly per the morphology rules.',
          },
          example: { type: 'STRING' },
          exampleGloss: { type: 'STRING' },
          notes: { type: 'STRING' },
        },
        required: ['lang', 'headword', 'meaning', 'morphologyJson'],
      },
    },
  },
  required: ['pos', 'entries'],
}

function callGemini(prompt: string, key: string, signal: AbortSignal) {
  // The tool-call instruction is Anthropic-specific; Gemini is told to fill
  // the schema instead, and morphology goes in as a JSON string.
  const adapted = prompt
    .replace(
      'Call the record_word tool. Do not write anything outside the tool call.',
      [
        'Answer with JSON matching the required schema and nothing else.',
        'Put each language\'s morphology object into "morphologyJson" as a',
        'JSON string — the same keys the rules above specify, serialised.',
      ].join(' '),
    )

  return fetch(`${GEMINI_URL(MODEL)}?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: adapted }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 4096,
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
  const parsed = JSON.parse(text) as {
    entries?: Array<{ morphologyJson?: string; morphology?: unknown }>
  }

  // Back into the shape the app validates: morphology as an object.
  for (const entry of parsed.entries ?? []) {
    if (typeof entry.morphologyJson === 'string') {
      try {
        entry.morphology = JSON.parse(entry.morphologyJson)
      } catch {
        // A morphology that will not parse costs that word its tables, not the
        // whole entry — the headword, meaning and example are still good.
      }
      delete entry.morphologyJson
    }
  }
  return parsed
}

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
