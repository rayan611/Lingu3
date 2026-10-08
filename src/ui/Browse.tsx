import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { reExpand } from '../ai/expand'
import { CATEGORIES, type Category, type Settings } from '../db/types'
import { WordCard } from './WordCard'

export function Browse({ settings }: Props) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<Category | 'all'>('all')
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

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
    // Soft delete: a hard delete can't be replicated to another device later.
    const concept = await db.concepts.get(id)
    if (concept) {
      await db.concepts.put({ ...concept, deletedAt: Date.now(), updatedAt: Date.now() })
    }
    await db.cards.where('conceptId').equals(id).delete()
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
