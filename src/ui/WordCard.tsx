import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import {
  LANG_BCP47,
  LANG_NAMES,
  RTL_LANGS,
  type Settings,
} from '../db/types'
import { genderBadge, morphLines } from '../lib/morphology'

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
  const data = useLiveQuery(async () => {
    const concept = await db.concepts.get(conceptId)
    if (!concept) return null
    const entries = await db.entries.where('conceptId').equals(conceptId).toArray()
    return { concept, entries }
  }, [conceptId])

  if (!data) return null
  const { concept, entries } = data
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
        <span className="badge">{concept.pos}</span>
        <span className="badge subtle">{concept.category}</span>
      </div>

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
