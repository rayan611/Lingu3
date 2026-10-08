import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { reExpand } from '../ai/expand'
import { isIncomplete } from '../lib/morphology'
import { CATEGORIES, type Category, type Settings } from '../db/types'
import { WordCard } from './WordCard'

export function Browse({ settings }: Props) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<Category | 'all'>('all')
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /**
   * Which words came back from the model with something missing — a Swedish or
   * German noun with no gender, or no entries at all. A wrong or absent
   * der/die/das is the single most expensive error this app can make, because
   * the scheduler will then drill it for months. `redo` already existed to fix
   * them; nothing told you which ones to fix.
   */
  const flagged = useLiveQuery(async () => {
    const entries = await db.entries.toArray()
    const seen = new Set<string>()
    const bad = new Set<string>()
    for (const e of entries) {
      seen.add(e.conceptId)
      if (settings.targetLangs.includes(e.lang) && isIncomplete(e)) {
        bad.add(e.conceptId)
      }
    }
    return { bad, seen }
  }, [settings.targetLangs], { bad: new Set<string>(), seen: new Set<string>() })

  const concepts = useLiveQuery(async () => {
    const all = await db.concepts.orderBy('createdAt').reverse().toArray()
    const q = query.trim().toLocaleLowerCase()
    return all.filter((c) => {
      if (c.deletedAt) return false
      if (category !== 'all' && c.category !== category) return false
      if (!q) return true
      return c.lemma.toLocaleLowerCase().includes(q)
    })
  }, [query, category], [])

  async function handleReExpand(id: string) {
    setBusy(true)
    try {
      await reExpand(id, settings)
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this word and its review history?')) return
    const now = Date.now()

    // Soft delete throughout. Removing the card rows locally while they live
    // on the server meant the next full resync quietly put them back, because
    // a row that is absent locally always looks older than the remote one.
    // Suspending them instead takes them out of the queue and replicates.
    const concept = await db.concepts.get(id)
    if (concept) {
      await db.concepts.put({ ...concept, deletedAt: now, updatedAt: now })
    }
    const cards = await db.cards.where('conceptId').equals(id).toArray()
    if (cards.length) {
      await db.cards.bulkPut(
        cards.map((c) => ({ ...c, suspended: true, updatedAt: now })),
      )
    }
    if (selected === id) setSelected(null)
  }

  return (
    <div className="stack">
      <div className="panel">
        <h2>Your words</h2>
        <div className="row">
          <input
            className="field-grow"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
          />
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as Category | 'all')}
          >
            <option value="all">All categories</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <p className="muted small">{concepts.length} words</p>

        <ul className="word-list">
          {concepts.map((c) => (
            <li key={c.id} className={selected === c.id ? 'active' : ''}>
              <button className="word-list-item" onClick={() => setSelected(c.id)}>
                <span className="word-list-lemma">{c.lemma}</span>
                <span className="badge subtle">{c.pos}</span>
                {!flagged.seen.has(c.id) ? (
                  <span className="badge flag" title="No translations yet">
                    not expanded
                  </span>
                ) : flagged.bad.has(c.id) ? (
                  <span
                    className="badge flag"
                    title="A noun came back without its gender — press redo"
                  >
                    check gender
                  </span>
                ) : null}
              </button>
              <div className="word-list-actions">
                <button
                  className="link"
                  disabled={busy}
                  onClick={() => void handleReExpand(c.id)}
                  title="Ask the model again — your review schedule is kept"
                >
                  redo
                </button>
                <button className="link danger" onClick={() => void handleDelete(c.id)}>
                  delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>

      {selected && <WordCard conceptId={selected} settings={settings} />}
    </div>
  )
}

interface Props {
  settings: Settings
}
