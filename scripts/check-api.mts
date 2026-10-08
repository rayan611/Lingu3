/**
 * The expansion endpoint, exercised through both calling conventions.
 *
 * This suite exists because the function worked perfectly when read and was
 * broken in production for a day: Vercel hands it the older Node (req, res)
 * pair, and a handler written for web objects fails silently under it — it
 * hangs until the gateway times out, or throws on req.json() and is answered
 * with an HTML error page the app cannot parse. Neither typecheck nor build
 * can see that; only calling it both ways can.
 */
// Set before the module is loaded: the endpoint reads its configuration at
// import time, and the point of this suite is the configured path.
process.env.VITE_SUPABASE_URL ??= 'https://example.supabase.co'
process.env.VITE_SUPABASE_ANON_KEY ??= 'test-key'

const { default: handler, readGemini, readAnthropic } = await import('../api/expand')

const payload = {
  lemma: 'hund',
  sourceLang: 'sv',
  nativeLang: 'fa',
  langs: ['fa', 'sv', 'de', 'en'],
}

let failures = 0

function check(label: string, ok: boolean, detail: string) {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

async function asWeb(method: string, headers: Record<string, string>, body?: unknown) {
  const res = (await handler(
    new Request('https://x/api/expand', {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    }),
  )) as Response
  return { status: res.status, text: await res.text() }
}

async function asNode(method: string, headers: Record<string, string>, body?: unknown) {
  let text = ''
  const res = {
    statusCode: 0,
    setHeader: () => {},
    end: (b?: string) => {
      text = b ?? ''
    },
  }
  await handler({ method, url: '/api/expand', headers, body } as never, res as never)
  return { status: res.statusCode, text }
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

console.log('\nThe expansion endpoint answers under both calling conventions')

for (const [name, call] of [
  ['web', asWeb],
  ['node', asNode],
] as const) {
  const get = await call('GET', {})
  check(`${name}: GET is refused with JSON, not a hang`, get.status === 405 && isJson(get.text), `${get.status} ${get.text.slice(0, 80)}`)

  const post = await call('POST', { 'content-type': 'application/json' }, payload)
  check(
    `${name}: POST answers with JSON the app can read`,
    isJson(post.text) && typeof JSON.parse(post.text).error === 'string',
    `${post.status} ${post.text.slice(0, 80)}`,
  )
  check(`${name}: POST is rejected without a session`, post.status === 401, `got ${post.status}`)

  const empty = await call('POST', { 'content-type': 'application/json' }, { langs: [] })
  check(`${name}: a malformed body is a clean error, not a crash`, isJson(empty.text), empty.text.slice(0, 80))
}

console.log('\nBoth providers normalise to the same shape')

// Gemini cannot express a per-language morphology object in its schema, so it
// returns one as a JSON string. If this unwrapping breaks, every entry silently
// loses its genders and verb forms while still looking fine.
const gemini = readGemini({
  candidates: [
    {
      content: {
        parts: [
          {
            text: JSON.stringify({
              pos: 'noun',
              entries: [
                {
                  lang: 'de',
                  headword: 'der Hund',
                  meaning: 'dog',
                  morphologyJson: '{"kind":"noun","gender":"der","plural":"Hunde"}',
                },
              ],
            }),
          },
        ],
      },
    },
  ],
}) as { entries: Array<{ morphology?: { gender?: string }; morphologyJson?: string }> }

check(
  'gemini: morphology comes back as an object, not a string',
  gemini.entries[0].morphology?.gender === 'der',
  JSON.stringify(gemini.entries[0]),
)
check(
  'gemini: the string field is removed',
  gemini.entries[0].morphologyJson === undefined,
  'morphologyJson survived',
)

const anthropic = readAnthropic({
  content: [{ type: 'tool_use', name: 'record_word', input: { pos: 'noun', entries: [] } }],
}) as { pos?: string }
check('anthropic: the tool call is unwrapped', anthropic?.pos === 'noun', JSON.stringify(anthropic))

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`)
  process.exit(1)
}
console.log('\nAll endpoint checks passed.')
