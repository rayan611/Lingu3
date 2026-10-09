import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import {
  commitPreview,
  previewWord,
  processPending,
  type WordPreview,
} from '../ai/expand'
import {
  CATEGORIES,
  LANG_NAMES,
  type Category,
  type Lang,
  type Settings,
} from '../db/types'
import { WordCard } from './WordCard'
import { BulkAdd } from './BulkAdd'
import { PreviewCard } from './PreviewCard'

interface Props {
  settings: Settings
}

export function AddWord({ settings }: Props) {
  const [lemma, setLemma] = useState('')
  const [hint, setHint] = useState('')
  const [sourceLang, setSourceLang] = useState<Lang>(settings.nativeLang)
  const [category, setCategory] = useState<Category>('daily')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ kind: string; text: string } | null>(null)
  const [lastId, setLastId] = useState<string | null>(null)
  const [preview, setPreview] = useState<WordPreview | null>(null)
  /**
   * Skip the confirmation step. The flow underneath is identical either way —
   * expand, then write — so this is one branch at the end, not a second path
   * through the code.
   */
  const [quick, setQuick] = useState(false)

  const pending = useLiveQuery(
    () => db.pending.orderBy('createdAt').toArray(),
    [],
    [],
  )
  const pendingCount = pending.length
  // The reason the last expansion failed. It was always recorded; it just had
  // nowhere to be seen, which meant a broken endpoint looked like a broken app.
  const lastError = pending[pending.length - 1]?.lastError
  const recent = useLiveQuery(
    () => db.concepts.orderBy('createdAt').reverse().limit(6).toArray(),
    [],
    [],
  )

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!lemma.trim() || busy) return
    setBusy(true)
    setStatus(null)
    setPreview(null)
    try {
      // Always expand first and look at it. The only difference quick mode
      // makes is that it does not stop to ask.
      const result = await previewWord({
        lemma,
        sourceLang,
        hint: hint.trim() || undefined,
        settings,
      })

      if (result.status === 'duplicate') {
        setLastId(result.conceptId)
        setStatus({
          kind: 'warn',
          text: `"${result.lemma}" is already in your list — nothing was added, and no model call was spent.`,
        })
        return
      }

      if (quick) {
        await save(result.preview)
      } else {
        setPreview(result.preview)
      }
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  /** Writes a preview. No model call — the expansion is already on screen. */
  async function save(toSave: WordPreview) {
    setBusy(true)
    try {
      const result = await commitPreview({
        preview: toSave,
        category,
        settings,
      })
      setLastId(result.conceptId)
      if (result.status === 'duplicate') {
        setStatus({ kind: 'warn', text: result.message ?? 'Already saved.' })
      } else {
        setStatus({ kind: 'ok', text: `Added "${toSave.lemma}".` })
        setLemma('')
        setHint('')
      }
      setPreview(null)
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  async function retryPending() {
    setBusy(true)
    const { done, failed } = await processPending(settings)
    setStatus({
      kind: failed > 0 ? 'warn' : 'ok',
      text: `Expanded ${done}${failed > 0 ? `, ${failed} still waiting` : ''}.`,
    })
    setBusy(false)
  }

  return (
    <div className="stack">
      <form className="panel" onSubmit={submit}>
        <h2>Add a word</h2>
        <p className="muted small">
          One entry becomes {settings.targetLangs.length} languages, with genders
          and verb forms. Check shows you the result; nothing is saved until you
          press Add.
        </p>

        <input
          className="word-input"
          value={lemma}
          onChange={(e) => setLemma(e.target.value)}
          placeholder="Word, verb, or short phrase"
          autoFocus
          disabled={busy}
        />

        <div className="row">
          <label className="field">
            <span>I typed it in</span>
            <select
              value={sourceLang}
              onChange={(e) => setSourceLang(e.target.value as Lang)}
            >
              {[settings.nativeLang, ...settings.targetLangs].map((l) => (
                <option key={l} value={l}>
                  {LANG_NAMES[l]}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Category</span>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as Category)}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="field">
          <span className="optional">
            Which sense? <em>optional — only when the word is ambiguous</em>
          </span>
          <input
            value={hint}
            onChange={(e) => setHint(e.target.value)}
            placeholder='e.g. "bank" as in river bank'
            disabled={busy}
          />
        </label>

        <button className="primary" type="submit" disabled={busy || !lemma.trim()}>
          {busy ? 'Expanding…' : quick ? 'Add' : 'Check'}
        </button>

        <label className="checkline">
          <input
            type="checkbox"
            checked={quick}
            onChange={(e) => setQuick(e.target.checked)}
          />
          <span>
            Quick add — save straight away, without showing it first
          </span>
        </label>

        {status && <div className={`status ${status.kind}`}>{status.text}</div>}
      </form>

      {pendingCount > 0 && (
        <div className="panel warn-panel">
          <strong>
            {pendingCount} word{pendingCount === 1 ? '' : 's'} waiting
          </strong>
          <p className="muted small">
            Saved on this device, but not expanded into the other languages
            yet. Words added offline fill in by themselves; anything else is
            the expansion service failing, and the reason is below.
          </p>
          {lastError && <pre className="pending-detail">{lastError}</pre>}
          <div className="row">
            <button onClick={() => void retryPending()} disabled={busy}>
              Expand now
            </button>
            {lastError && (
              <button
                className="link"
                onClick={() => void navigator.clipboard?.writeText(lastError)}
              >
                Copy error
              </button>
            )}
          </div>
        </div>
      )}

      {preview && (
        <PreviewCard
          preview={preview}
          settings={settings}
          busy={busy}
          onAdd={() => void save(preview)}
        />
      )}

      <BulkAdd settings={settings} />

      {lastId && <WordCard conceptId={lastId} settings={settings} />}

      {recent.length > 0 && (
        <div className="panel">
          <h3>Recently added</h3>
          <ul className="chip-list">
            {recent.map((c) => (
              <li key={c.id}>
                <button className="chip" onClick={() => setLastId(c.id)}>
                  {c.lemma}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
