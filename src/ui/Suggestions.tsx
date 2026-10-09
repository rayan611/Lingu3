import { useCallback, useEffect, useState } from 'react'
import { newId } from '../db/db'
import { authConfigured, supabase } from '../auth/supabase'

/**
 * Suggestions go straight to Supabase, not through Dexie and the sync loop.
 *
 * Everything else in this app is your own data: it belongs on your device
 * first and reaches the server when it can. A suggestion is the opposite — it
 * is only worth anything once it has left your device, and it is never read
 * back locally. Putting it in the offline store would mean a sync mapping, a
 * cursor and a row type for something that is written once and forgotten.
 *
 * The cost is honest: send it while offline and it fails, and says so.
 */

export interface SuggestionRow {
  id: string
  user_id: string
  body: string
  context: string | null
  status: 'new' | 'read' | 'done' | 'dismissed'
  created_at: string
}

const MAX = 2000

export function SuggestionBox({ context }: { context?: string }) {
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function send() {
    const text = body.trim()
    if (!text || busy) return
    setBusy(true)
    setError(null)
    try {
      const sb = supabase()
      const { data: auth } = await sb.auth.getUser()
      const userId = auth.user?.id
      if (!userId) throw new Error('You need to be signed in to send this.')
      // The id is generated here rather than defaulted in Postgres so a
      // double-tap that somehow sends twice collides instead of duplicating.
      const { error: err } = await sb.from('suggestions').insert({
        id: newId(),
        user_id: userId,
        body: text,
        context: context ?? null,
      })
      if (err) throw new Error(err.message)
      setBody('')
      setSent(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (!authConfigured) return null

  return (
    <div className="panel">
      <h2>Suggest something</h2>
      <p className="muted small">
        A bug, a word the model got wrong, anything missing. It reaches Rayan
        directly.
      </p>
      <textarea
        className="suggestion-input"
        value={body}
        onChange={(e) => {
          setBody(e.target.value.slice(0, MAX))
          setSent(false)
        }}
        rows={4}
        placeholder="What would make this better?"
        disabled={busy}
      />
      <div className="row space-between">
        <span className="muted small">
          {body.length > MAX - 200 ? `${MAX - body.length} characters left` : ''}
        </span>
        <button className="primary" onClick={() => void send()} disabled={busy || !body.trim()}>
          {busy ? 'Sending…' : 'Send'}
        </button>
      </div>
      {sent && <p className="muted small">Sent — thank you.</p>}
      {error && <p className="error-text small">{error}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

interface AdminStats {
  users: number
  users_active_7d: number
  concepts: number
  entries: number
  cards: number
  reviews: number
  stories: number
  suggestions_new: number
  db_bytes: number
}

/**
 * The admin panel.
 *
 * Rendered only when `admin_stats()` actually answers. The flag is not read
 * from the local settings row and then trusted: that row is synced, so it is
 * client state, and client state deciding what an admin sees would be a
 * decoration over a check the database is already doing. If the function
 * raises `not authorised`, there is no panel. The database is the authority
 * in both directions.
 */
export function AdminPanel() {
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [suggestions, setSuggestions] = useState<SuggestionRow[] | null>(null)
  const [denied, setDenied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const sb = supabase()
      const { data, error: err } = await sb.rpc('admin_stats')
      if (err) {
        // 42501 is the function's own refusal. Anything else is a real fault
        // and should be visible rather than silently hiding the panel.
        if (err.code === '42501' || /not authoris/i.test(err.message)) {
          setDenied(true)
          return
        }
        throw new Error(err.message)
      }
      setStats(data as AdminStats)

      const { data: rows, error: sErr } = await sb
        .from('suggestions')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100)
      if (sErr) throw new Error(sErr.message)
      setSuggestions((rows ?? []) as SuggestionRow[])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    if (!authConfigured) return
    void load()
  }, [load])

  async function setStatus(id: string, status: SuggestionRow['status']) {
    // Optimistic: the row is already on screen and the only thing that can
    // fail is the write, which reloads below.
    setSuggestions((rows) =>
      rows?.map((r) => (r.id === id ? { ...r, status } : r)) ?? null,
    )
    const { error: err } = await supabase()
      .from('suggestions')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', id)
    if (err) {
      setError(err.message)
      void load()
    }
  }

  if (!authConfigured || denied) return null
  if (error) {
    return (
      <div className="panel">
        <h2>Admin</h2>
        <p className="error-text small">{error}</p>
      </div>
    )
  }
  if (!stats) return <div className="panel muted">Loading admin…</div>

  const open = suggestions?.filter((s) => s.status === 'new' || s.status === 'read') ?? []
  const closed = suggestions?.filter((s) => s.status === 'done' || s.status === 'dismissed') ?? []

  return (
    <div className="panel">
      <h2>Admin</h2>

      <dl className="stat-grid">
        <Stat label="Users" value={stats.users} />
        <Stat label="Active, 7d" value={stats.users_active_7d} />
        <Stat label="Words" value={stats.concepts} />
        <Stat label="Cards" value={stats.cards} />
        <Stat label="Reviews" value={stats.reviews} />
        <Stat label="Texts" value={stats.stories} />
        <Stat label="Database" value={formatBytes(stats.db_bytes)} />
        <Stat label="New suggestions" value={stats.suggestions_new} />
      </dl>

      <h3>Suggestions</h3>
      {open.length === 0 && closed.length === 0 && (
        <p className="muted small">Nothing yet.</p>
      )}
      {open.map((s) => (
        <Suggestion key={s.id} row={s} onStatus={setStatus} />
      ))}
      {closed.length > 0 && (
        <details className="closed-suggestions">
          <summary className="muted small">
            {closed.length} handled
          </summary>
          {closed.map((s) => (
            <Suggestion key={s.id} row={s} onStatus={setStatus} />
          ))}
        </details>
      )}
    </div>
  )
}

function Suggestion({
  row,
  onStatus,
}: {
  row: SuggestionRow
  onStatus: (id: string, status: SuggestionRow['status']) => void
}) {
  return (
    <div className={`suggestion status-${row.status}`}>
      <div className="suggestion-head">
        <span className="muted small">
          {new Date(row.created_at).toLocaleDateString()}
          {row.context ? ` · ${row.context}` : ''}
        </span>
        <span className={`badge subtle`}>{row.status}</span>
      </div>
      <p className="suggestion-body">{row.body}</p>
      <div className="row">
        {row.status !== 'done' && (
          <button className="link" onClick={() => onStatus(row.id, 'done')}>
            Done
          </button>
        )}
        {row.status !== 'dismissed' && (
          <button className="link" onClick={() => onStatus(row.id, 'dismissed')}>
            Dismiss
          </button>
        )}
        {row.status !== 'new' && (
          <button className="link" onClick={() => onStatus(row.id, 'new')}>
            Reopen
          </button>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="stat">
      <dt>{label}</dt>
      <dd>{typeof value === 'number' ? value.toLocaleString() : value}</dd>
    </div>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`
}
