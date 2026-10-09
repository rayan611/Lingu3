import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { addWord, processPending } from '../ai/expand'
import {
  CATEGORIES,
  LANG_NAMES,
  type Category,
  type Lang,
  type Settings,
} from '../db/types'
import { WordCard } from './WordCard'
import { BulkAdd } from './BulkAdd'

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
    try {
      const result = await addWord({
        lemma,
        sourceLang,
        category,
        hint: hint.trim() || undefined,
        settings,
      })
      setLastId(result.conceptId)
      if (result.status === 'expanded') {
        setStatus({ kind: 'ok', text: `Added "${lemma.trim()}".` })
        setLemma('')
        setHint('')
      } else if (result.status === 'duplicate') {
        setStatus({ kind: 'warn', text: result.message ?? 'Already saved.' })
      } else {
        setStatus({
          kind: 'warn',
          text: `Saved, but not expanded yet (${result.message}). It will fill in when you are back online.`,
        })
        setLemma('')
        setHint('')
      }
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
          and verb forms.
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
          {busy ? 'Expanding…' : 'Add'}
        </button>

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
