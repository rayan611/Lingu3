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
const MODEL = process.env.LINGUA_MODEL ?? 'claude-haiku-5-5'
const API_URL = 'https://api.anthropic.com/v1/messages'

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

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return json(
      { error: 'ANTHROPIC_API_KEY is not configured on the server.' },
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

  let upstream: Response
  try {
    upstream = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
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
  } catch (err) {
    return json({ error: `Could not reach the model: ${String(err)}` }, 502)
  }

  if (!upstream.ok) {
    const detail = await upstream.text()
    return json(
      { error: `Model request failed (${upstream.status}).`, detail: detail.slice(0, 500) },
      upstream.status === 429 ? 429 : 502,
    )
  }

  const data = (await upstream.json()) as {
    content?: Array<{ type: string; name?: string; input?: unknown }>
  }
  const block = data.content?.find(
    (c) => c.type === 'tool_use' && c.name === 'record_word',
  )

  if (!block?.input) {
    return json({ error: 'Model did not return a usable result.' }, 502)
  }

  return json(block.input, 200)
}

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
