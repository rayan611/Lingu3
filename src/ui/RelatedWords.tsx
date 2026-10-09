import { useEffect, useState } from 'react'
import { db, lemmaKey } from '../db/db'
import { addRelatedWord, RELATED_STAGGER_DAYS } from '../ai/expand'
import {
  LANG_BCP47,
  LANG_NAMES,
  RTL_LANGS,
  type Category,
  type RelatedWord,
  type Settings,
} from '../db/types'

/**
 * Words worth knowing beside this one.
 *
 * Suggestions only — nothing is added without a click. Two reasons, and the
 * second is the real one:
 *
 *   1. a list you did not ask for silently doubling your deck is unpleasant;
 *   2. semantically similar words learned at the same time interfere with each
 *      other, so a word and its register variant should not arrive in the same
 *      review session. Added words wait a few days for their first review.
 *
 * What is asked for is register rather than synonymy: hallo and tjena mean the
 * same thing, and knowing which to use with your manager is the part a
 * dictionary will not tell you.
 */
export function RelatedWords({
  related,
  settings,
  category,
}: {
  related: RelatedWord[]
  settings: Settings
  category: Category
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [done, setDone] = useState<Record<string, string>>({})
  const [known, setKnown] = useState<Set<string>>(new Set())

  const shown = related.filter(
    (r) => r.lang !== settings.nativeLang && settings.targetLangs.includes(r.lang),
  )

  // Anything already in the list is not a suggestion. Checked against stored
  // headwords too, so a word you added in Swedish is not offered again here.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const hits = new Set<string>()
      for (const r of shown) {
        const key = lemmaKey(r.word, r.lang)
        const match = await db.entries
          .where('lang')
          .equals(r.lang)
          .filter((e) => lemmaKey(e.headword, e.lang) === key)
          .first()
        if (match) hits.add(`${r.lang}:${r.word}`)
      }
      if (!cancelled) setKnown(hits)
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [related])

  if (shown.length === 0) return null

  async function add(r: RelatedWord) {
    const id = `${r.lang}:${r.word}`
    setBusy(id)
    try {
      const result = await addRelatedWord({
        lemma: r.word,
        sourceLang: r.lang,
        category,
        settings,
      })
      setDone((d) => ({
        ...d,
        [id]:
          result.status === 'duplicate'
            ? 'already saved'
            : result.status === 'queued'
              ? 'saved — will expand later'
              : `added, first review in ${RELATED_STAGGER_DAYS} days`,
      }))
    } catch (err) {
      setDone((d) => ({
        ...d,
        [id]: err instanceof Error ? err.message : String(err),
      }))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="panel related">
      <h3>Worth knowing beside it</h3>
      <p className="muted small">
        Mostly register, not synonyms — the difference between these is usually
        who you are talking to. Added words wait {RELATED_STAGGER_DAYS} days
        before their first review, so they do not turn up in the same session as
        the word they came from.
      </p>

      <ul className="related-list">
        {shown.map((r) => {
          const id = `${r.lang}:${r.word}`
          const status = done[id]
          const already = known.has(id)
          return (
            <li key={id}>
              <div className="related-main">
                <span
                  className={`related-word ${RTL_LANGS.has(r.lang) ? 'rtl' : ''}`}
                  lang={LANG_BCP47[r.lang]}
                >
                  {r.word}
                </span>
                <span className="badge subtle">{LANG_NAMES[r.lang]}</span>
                {r.register && <span className="badge">{r.register}</span>}
              </div>
              {r.meaning && <div className="related-meaning">{r.meaning}</div>}
              {r.note && <div className="note">{r.note}</div>}
              <div className="related-action">
                {status ? (
                  <span className="muted small">{status}</span>
                ) : already ? (
                  <span className="muted small">already in your list</span>
                ) : (
                  <button
                    className="chip"
                    disabled={busy !== null}
                    onClick={() => void add(r)}
                  >
                    {busy === id ? 'adding…' : '+ add'}
                  </button>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
