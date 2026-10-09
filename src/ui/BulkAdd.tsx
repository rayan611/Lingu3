import { useState } from 'react'
import {
  addWordsBulk,
  parseBulkInput,
  processPending,
  type BulkAddResult,
} from '../ai/expand'
import {
  CATEGORIES,
  LANG_NAMES,
  type Category,
  type Lang,
  type Settings,
} from '../db/types'

/**
 * Paste a list, get a deck.
 *
 * Nothing here calls the model directly. Every line becomes a concept plus a
 * pending row, and the queue that already handles offline adds does the
 * expanding — so a list pasted on a train fills itself in later, and a list
 * pasted at a desk fills in while you watch.
 */
export function BulkAdd({ settings }: { settings: Settings }) {
  const [text, setText] = useState('')
  const [sourceLang, setSourceLang] = useState<Lang>(settings.nativeLang)
  const [category, setCategory] = useState<Category>('daily')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<BulkAddResult | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(
    null,
  )
  const [summary, setSummary] = useState<string | null>(null)

  const lines = parseBulkInput(text)

  async function run() {
    if (lines.length === 0 || busy) return
    setBusy(true)
    setSummary(null)
    setProgress(null)
    try {
      const added = await addWordsBulk({ lines, sourceLang, category })
      setResult(added)
      setText('')

      if (added.queued > 0 && navigator.onLine) {
        setProgress({ done: 0, total: added.queued })
        const { done, failed } = await processPending(settings, (d, t) =>
          setProgress({ done: d, total: t }),
        )
        setSummary(
          failed > 0
            ? `Expanded ${done}. ${failed} still waiting — the reason is on the Add tab.`
            : `Expanded ${done}.`,
        )
      } else if (added.queued > 0) {
        setSummary('Saved. They will expand when you are back online.')
      }
    } catch (err) {
      setSummary(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  return (
    <div className="panel">
      <h3>Add a list</h3>
      <p className="muted small">
        One word per line. Anything after a comma on the same line is treated as
        the sense, for when a word is ambiguous.
      </p>

      <textarea
        className="bulk-input"
        rows={7}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'hund\nspringa, to run\nbank, the river kind'}
        disabled={busy}
        spellCheck={false}
      />

      <div className="row">
        <label className="field">
          <span>I typed them in</span>
          <select
            value={sourceLang}
            onChange={(e) => setSourceLang(e.target.value as Lang)}
            disabled={busy}
          >
            {[settings.nativeLang, ...settings.targetLangs].map((l) => (
              <option key={l} value={l}>
                {LANG_NAMES[l]}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Topic for the whole list</span>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as Category)}
            disabled={busy}
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
      </div>

      <button
        className="primary"
        onClick={() => void run()}
        disabled={busy || lines.length === 0}
      >
        {busy
          ? progress
            ? `Expanding ${progress.done} of ${progress.total}…`
            : 'Saving…'
          : `Add ${lines.length || ''} word${lines.length === 1 ? '' : 's'}`}
      </button>

      {progress && progress.total > 0 && (
        <div className="progress">
          <div
            className="progress-bar"
            style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
          />
        </div>
      )}

      {result && (
        <div className={`status ${result.duplicates.length ? 'warn' : 'ok'}`}>
          Queued {result.queued} word{result.queued === 1 ? '' : 's'}.
          {result.duplicates.length > 0 && (
            <>
              {' '}
              Skipped {result.duplicates.length} already in your list:{' '}
              {result.duplicates
                .slice(0, 8)
                .map((d) =>
                  d.lemma.toLocaleLowerCase() === d.existing.toLocaleLowerCase()
                    ? d.lemma
                    : `${d.lemma} (have "${d.existing}")`,
                )
                .join(', ')}
              {result.duplicates.length > 8 ? '…' : ''}
            </>
          )}
        </div>
      )}

      {summary && <div className="status ok">{summary}</div>}
    </div>
  )
}
