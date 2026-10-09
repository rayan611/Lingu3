import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import {
  LANG_BCP47,
  LANG_NAMES,
  RTL_LANGS,
  type Settings,
} from '../db/types'
import { genderBadge, morphLines } from '../lib/morphology'
import { normaliseTags } from '../ai/expand'
import { TagEditor } from './TagEditor'
import { PARTS_OF_SPEECH, type PartOfSpeech } from '../db/types'

/**
 * The full entry for one word, with every language stacked in priority order.
 * This is the comparison view — seeing hund / Hund / dog together is the point,
 * and it is also where you catch a bad expansion before it reaches your cards.
 */
export function WordCard({
  conceptId,
  settings,
}: {
  conceptId: string
  settings: Settings
}) {
  /** Topics already in use elsewhere, offered as one-tap additions. */
  const suggestions = useLiveQuery(
    async () => {
      const all = await db.concepts.toArray()
      const counts = new Map<string, number>()
      for (const c of all) {
        if (c.deletedAt) continue
        for (const t of c.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1)
      }
      return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t)
    },
    [],
    [],
  )

  const data = useLiveQuery(async () => {
    const concept = await db.concepts.get(conceptId)
    if (!concept) return null
    const entries = await db.entries.where('conceptId').equals(conceptId).toArray()
    return { concept, entries }
  }, [conceptId])

  if (!data) return null
  const { concept, entries } = data

  /** Edits here write through immediately; `updatedAt` is what carries them
      to the other device on the next sync. */
  async function patch(fields: Partial<typeof concept>) {
    const current = await db.concepts.get(conceptId)
    if (!current) return
    await db.concepts.put({ ...current, ...fields, updatedAt: Date.now() })
  }
  const order = [settings.nativeLang, ...settings.targetLangs]
  const sorted = entries
    .filter((e) => order.includes(e.lang))
    .sort((a, b) => order.indexOf(a.lang) - order.indexOf(b.lang))

  if (sorted.length === 0) {
    return (
      <div className="panel">
        <h3>{concept.lemma}</h3>
        <p className="muted small">Not expanded yet.</p>
      </div>
    )
  }

  return (
    <div className="panel word-card">
      <div className="word-card-head">
        <h3>{concept.lemma}</h3>
        {/* Part of speech is the model's, but it is wrong often enough on
            phrases that it has to be correctable. */}
        <select
          className="pos-select"
          value={concept.pos}
          onChange={(e) => void patch({ pos: e.target.value as PartOfSpeech })}
          aria-label="Part of speech"
        >
          {PARTS_OF_SPEECH.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>

      <TagEditor
        tags={concept.tags ?? []}
        suggestions={suggestions}
        onChange={(next) => void patch({ tags: normaliseTags(next) })}
      />

      <div className="lang-stack">
        {sorted.map((entry) => {
          const gender = genderBadge(entry.lang, entry.morphology)
          const lines = morphLines(entry.lang, entry.morphology)
          const isNative = entry.lang === settings.nativeLang
          const inactive =
            !isNative && !settings.activeLangs.includes(entry.lang)
          return (
            <div
              key={entry.lang}
              className={`lang-row ${isNative ? 'native' : ''} ${inactive ? 'inactive' : ''}`}
            >
              <div className="lang-row-head">
                <span className="lang-chip">{LANG_NAMES[entry.lang]}</span>
                {gender && (
                  <span className={`gender gender-${gender}`}>{gender}</span>
                )}
                {inactive && <span className="badge subtle">paused</span>}
              </div>
              <div
                className={`answer-word ${RTL_LANGS.has(entry.lang) ? 'rtl' : ''}`}
                lang={LANG_BCP47[entry.lang]}
              >
                {entry.headword}
              </div>
              <div className="answer-meaning">{entry.meaning}</div>

              {lines.length > 0 && (
                <dl className="forms">
                  {lines.map((l) => (
                    <div key={l.label} className="form-row">
                      <dt>{l.label}</dt>
                      <dd lang={LANG_BCP47[entry.lang]}>{l.value}</dd>
                    </div>
                  ))}
                </dl>
              )}

              {entry.example && (
                <div className="example" lang={LANG_BCP47[entry.lang]}>
                  {entry.example}
                  {entry.exampleGloss && !isNative && (
                    <div
                      className={`example-gloss ${RTL_LANGS.has(settings.nativeLang) ? 'rtl' : ''}`}
                      lang={LANG_BCP47[settings.nativeLang]}
                    >
                      {entry.exampleGloss}
                    </div>
                  )}
                </div>
              )}
              {entry.notes && <div className="note">{entry.notes}</div>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
