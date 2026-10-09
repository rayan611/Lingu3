import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import {
  deleteStory,
  generateStory,
  lookupInText,
  saveStory,
  tokenise,
  type Coverage,
  type GeneratedStory,
  type StoryRequest,
} from '../ai/story'
import { addRelatedWord } from '../ai/expand'
import {
  LANG_BCP47,
  LANG_NAMES,
  STORY_GENRES,
  type Lang,
  type Settings,
  type Story,
} from '../db/types'

/**
 * Texts built out of the words you already know.
 *
 * The number that matters on this screen is coverage, not length. Nation's
 * reading research puts comprehension at roughly 95% known words with support
 * and about 98% without; below that a text stops being input and becomes
 * decoding. So the difficulty control is a slider for how many new words are
 * allowed, and the coverage shown afterwards is measured here against the real
 * vocabulary rather than taken from the model — which will drift off a
 * constrained word list however firmly it is asked not to.
 */
export function StoryMode({ settings }: { settings: Settings }) {
  const active = settings.targetLangs.filter((l) =>
    settings.activeLangs.includes(l),
  )
  const [lang, setLang] = useState<Lang>(active[0] ?? settings.targetLangs[0])
  const [genre, setGenre] = useState<string>('fun')
  const [length, setLength] = useState<'short' | 'long'>('short')
  const [unknownShare, setUnknownShare] = useState(5)
  const [topics, setTopics] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<
    { story: GeneratedStory; coverage: Coverage; req: StoryRequest } | null
  >(null)
  const [savedId, setSavedId] = useState<string | null>(null)
  const [reading, setReading] = useState<Story | null>(null)

  const allTopics = useLiveQuery(
    async () => {
      const concepts = await db.concepts.toArray()
      const set = new Set<string>()
      for (const c of concepts) {
        if (c.deletedAt) continue
        if (c.category) set.add(c.category)
        for (const t of c.tags ?? []) set.add(t)
      }
      return [...set].sort()
    },
    [],
    [],
  )

  const saved = useLiveQuery(
    async () => {
      const rows = await db.stories.orderBy('createdAt').reverse().toArray()
      return rows.filter((s) => !s.deletedAt)
    },
    [],
    [],
  )

  const wordCount = useLiveQuery(
    async () => (await db.entries.where('lang').equals(lang).toArray()).length,
    [lang],
    0,
  )

  async function run() {
    setBusy(true)
    setError(null)
    setResult(null)
    setSavedId(null)
    setReading(null)
    const req: StoryRequest = {
      lang,
      topics,
      genre,
      length,
      unknownShare: unknownShare / 100,
    }
    try {
      const { story, coverage } = await generateStory(req, settings)
      setResult({ story, coverage, req })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stack">
      <div className="panel">
        <h2>Reading</h2>
        <p className="muted small">
          A short text written from words you have already studied. You have{' '}
          {wordCount} in {LANG_NAMES[lang]}
          {wordCount < 150 && ' — expect it to lean on simple words until there are a few hundred'}
          .
        </p>

        <div className="row">
          <label className="field">
            <span>Language</span>
            <select value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
              {settings.targetLangs.map((l) => (
                <option key={l} value={l}>
                  {LANG_NAMES[l]}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Kind</span>
            <select value={genre} onChange={(e) => setGenre(e.target.value)}>
              {STORY_GENRES.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.label}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Length</span>
            <select
              value={length}
              onChange={(e) => setLength(e.target.value as 'short' | 'long')}
            >
              <option value="short">Short</option>
              <option value="long">Longer</option>
            </select>
          </label>
        </div>

        <label className="field">
          <span>New words allowed: {unknownShare}%</span>
          <input
            type="range"
            min={0}
            max={25}
            value={unknownShare}
            onChange={(e) => setUnknownShare(Number(e.target.value))}
          />
          <span className="muted small">
            This is the difficulty dial. Reading comprehension holds up to
            around 5% unfamiliar words with help, and 2% without; much past that
            and you are decoding rather than reading.
          </span>
        </label>

        {allTopics.length > 0 && (
          <div className="field">
            <span>Draw from</span>
            <div className="tag-row">
              <button
                className={`chip ${topics.length === 0 ? 'chip-on' : ''}`}
                onClick={() => setTopics([])}
              >
                everything
              </button>
              {allTopics.map((t) => (
                <button
                  key={t}
                  className={`chip ${topics.includes(t) ? 'chip-on' : ''}`}
                  onClick={() =>
                    setTopics((cur) =>
                      cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t],
                    )
                  }
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        )}

        <button className="primary" onClick={() => void run()} disabled={busy}>
          {busy ? 'Writing…' : 'Write me a text'}
        </button>

        {error && <div className="status error">{error}</div>}
      </div>

      {result && (
        <StoryView
          title={result.story.title}
          body={result.story.body}
          lang={result.req.lang}
          coverage={result.coverage}
          glossary={result.story.glossary}
          settings={settings}
          footer={
            savedId ? (
              <span className="muted small">Saved.</span>
            ) : (
              <button
                onClick={async () => {
                  const id = await saveStory({
                    story: result.story,
                    coverage: result.coverage,
                    req: result.req,
                  })
                  setSavedId(id)
                }}
              >
                Keep this one
              </button>
            )
          }
        />
      )}

      {reading && (
        <StoryView
          title={reading.title}
          body={reading.body}
          lang={reading.lang}
          coverage={{
            total: reading.wordCount,
            known: reading.knownCount,
            unknown: reading.unknownWords,
            ratio: reading.wordCount ? reading.knownCount / reading.wordCount : 0,
          }}
          glossary={reading.glossary ?? []}
          settings={settings}
          footer={
            <button className="link" onClick={() => setReading(null)}>
              Close
            </button>
          }
        />
      )}

      {saved.length > 0 && (
        <div className="panel">
          <h3>Kept</h3>
          <ul className="word-list">
            {saved.map((s) => (
              <li key={s.id}>
                <button className="word-list-item" onClick={() => setReading(s)}>
                  <span className="word-list-lemma">{s.title}</span>
                  <span className="badge subtle">{LANG_NAMES[s.lang]}</span>
                  <span className="muted small">
                    {new Date(s.createdAt).toLocaleDateString()}
                  </span>
                </button>
                <div className="word-list-actions">
                  <button
                    className="link danger"
                    onClick={() => void deleteStory(s.id)}
                  >
                    delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/**
 * The text itself, every word tappable.
 *
 * A tap checks your own vocabulary first — instant, offline, free — then the
 * glossary that came with the text. Only a word in neither needs the network,
 * which is the difference between reading this on a train and not.
 */
function StoryView({
  title,
  body,
  lang,
  coverage,
  glossary,
  settings,
  footer,
}: {
  title: string
  body: string
  lang: Lang
  coverage: Coverage
  glossary: { word: string; meaning: string }[]
  settings: Settings
  footer: React.ReactNode
}) {
  const [picked, setPicked] = useState<{
    word: string
    meaning: string | null
    source: 'yours' | 'glossary' | 'none'
  } | null>(null)
  const [adding, setAdding] = useState(false)
  const [addStatus, setAddStatus] = useState<string | null>(null)

  const unknown = new Set(coverage.unknown)

  async function tap(word: string) {
    setAddStatus(null)
    const hit = await lookupInText(word, lang, glossary)
    setPicked({
      word,
      meaning: hit?.meaning ?? null,
      source: hit?.source ?? 'none',
    })
  }

  async function add(word: string) {
    setAdding(true)
    try {
      const result = await addRelatedWord({
        lemma: word,
        sourceLang: lang,
        category: 'daily',
        settings,
      })
      setAddStatus(
        result.status === 'duplicate'
          ? 'Already in your list.'
          : result.status === 'queued'
            ? 'Saved — it will expand when you are back online.'
            : 'Added to your words.',
      )
    } catch (err) {
      setAddStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setAdding(false)
    }
  }

  const pct = Math.round(coverage.ratio * 100)

  return (
    <div className="panel story">
      <div className="word-card-head">
        <h3 lang={LANG_BCP47[lang]}>{title}</h3>
        <span
          className={`badge ${pct >= 95 ? '' : 'flag'}`}
          title="Words in this text that are already in your list. Comprehension holds up around 95% and above."
        >
          {coverage.known} of {coverage.total} known
        </span>
      </div>

      <p className="story-body" lang={LANG_BCP47[lang]}>
        {renderTappable(body, unknown, tap)}
      </p>

      {picked && (
        <div className="story-lookup">
          <strong lang={LANG_BCP47[lang]}>{picked.word}</strong>
          {picked.meaning ? (
            <>
              <span> — {picked.meaning}</span>
              {picked.source === 'yours' && (
                <span className="badge subtle">in your words</span>
              )}
            </>
          ) : (
            <span className="muted"> — not in your words or the glossary.</span>
          )}
          {picked.source !== 'yours' && (
            <div className="row">
              <button
                className="chip"
                disabled={adding}
                onClick={() => void add(picked.word)}
              >
                {adding ? 'adding…' : '+ add to my words'}
              </button>
              <button className="link" onClick={() => setPicked(null)}>
                close
              </button>
            </div>
          )}
          {addStatus && <div className="muted small">{addStatus}</div>}
        </div>
      )}

      {pct < 95 && (
        <p className="muted small">
          Below about 95% familiar, a text turns into decoding. Lower the new-word
          slider, or add the words underlined above and try again.
        </p>
      )}

      <div className="row">{footer}</div>
    </div>
  )
}

/** Wraps every word in a button, underlining the ones you have not studied. */
function renderTappable(
  body: string,
  unknown: Set<string>,
  onTap: (word: string) => void,
): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let cursor = 0
  let key = 0

  for (const paragraph of body.split(/\n+/)) {
    if (!paragraph.trim()) continue
    const words = tokenise(paragraph)
    const parts: React.ReactNode[] = []
    let pos = 0
    for (const word of words) {
      const at = paragraph.indexOf(word, pos)
      if (at < 0) continue
      if (at > pos) parts.push(paragraph.slice(pos, at))
      const isNew = unknown.has(word.toLocaleLowerCase())
      parts.push(
        <button
          key={`w${key++}`}
          className={`story-word ${isNew ? 'is-new' : ''}`}
          onClick={() => onTap(word)}
        >
          {word}
        </button>,
      )
      pos = at + word.length
    }
    if (pos < paragraph.length) parts.push(paragraph.slice(pos))
    out.push(<span key={`p${cursor++}`} className="story-para">{parts}</span>)
  }
  return out
}
