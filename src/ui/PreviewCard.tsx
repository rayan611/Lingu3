import {
  LANG_BCP47,
  LANG_NAMES,
  RTL_LANGS,
  parseMorphology,
  type Settings,
  type WordPreviewEntryView,
} from '../db/types'
import type { WordPreview } from '../ai/expand'
import { genderBadge, morphLines } from '../lib/morphology'

/**
 * What a word would look like if you saved it.
 *
 * Deliberately the same layout as the saved word card: the point of checking
 * before adding is to judge the thing you are about to get, so it should not
 * be rendered differently from the thing you get.
 */
export function PreviewCard({
  preview,
  settings,
  onAdd,
  busy,
}: {
  preview: WordPreview
  settings: Settings
  onAdd: () => void
  busy: boolean
}) {
  const order = [settings.nativeLang, ...settings.targetLangs]
  const rows: WordPreviewEntryView[] = preview.expansion.entries
    .filter((e) => order.includes(e.lang))
    .sort((a, b) => order.indexOf(a.lang) - order.indexOf(b.lang))
    .map((e) => ({ ...e, form: parseMorphology(e.lang, e.morphology) }))

  return (
    <div className="panel word-card preview-card">
      <div className="word-card-head">
        <h3>{preview.expansion.normalisedLemma?.trim() || preview.lemma}</h3>
        <span className="badge">{preview.expansion.pos}</span>
        <span className="badge subtle">not saved yet</span>
      </div>

      {preview.expansion.normalisedLemma &&
        preview.expansion.normalisedLemma.trim().toLocaleLowerCase() !==
          preview.lemma.toLocaleLowerCase() && (
          <p className="muted small">
            Tidied from “{preview.lemma}”.
          </p>
        )}

      <div className="lang-stack">
        {rows.map((entry) => {
          const gender = genderBadge(entry.lang, entry.form)
          const lines = morphLines(entry.lang, entry.form)
          const isNative = entry.lang === settings.nativeLang
          return (
            <div
              key={entry.lang}
              className={`lang-row ${isNative ? 'native' : ''}`}
            >
              <div className="lang-row-head">
                <span className="lang-chip">{LANG_NAMES[entry.lang]}</span>
                {gender && (
                  <span className={`gender gender-${gender}`}>{gender}</span>
                )}
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

      {/* The second Add. The first one is at the top of the form; this one is
          here so confirming does not mean scrolling back up past everything
          you just came down to read. */}
      <button className="primary big" onClick={onAdd} disabled={busy}>
        {busy ? 'Saving…' : 'Add to my words'}
      </button>
    </div>
  )
}
