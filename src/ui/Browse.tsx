import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { reExpand } from '../ai/expand'
import { isIncomplete } from '../lib/morphology'
import { type Settings } from '../db/types'
import { leechCounts, matchesTopic, LEECH_LAPSES } from '../fsrs/queue'
import { WordCard } from './WordCard'

export function Browse({ settings }: Props) {
  const [query, setQuery] = useState('')
  const [topic, setTopic] = useState<string>('all')
  const [troubleOnly, setTroubleOnly] = useState(false)
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

  /**
   * Words you keep forgetting. FSRS reschedules a lapse but has no opinion
   * about a card failed over and over, so without this a handful of bad words
   * quietly dominate every session forever.
   */
  const leeches = useLiveQuery(() => leechCounts(), [], new Map<string, number>())

  /** Concepts whose cards are all suspended, so the button can say "resume". */
  const paused = useLiveQuery(
    async () => {
      const cards = await db.cards.toArray()
      const byConcept = new Map<string, { total: number; off: number }>()
      for (const c of cards) {
        const row = byConcept.get(c.conceptId) ?? { total: 0, off: 0 }
        row.total++
        if (c.suspended) row.off++
        byConcept.set(c.conceptId, row)
      }
      const out = new Set<string>()
      for (const [id, row] of byConcept) {
        if (row.total > 0 && row.total === row.off) out.add(id)
      }
      return out
    },
    [],
    new Set<string>(),
  )

  const concepts = useLiveQuery(async () => {
    const all = await db.concepts.orderBy('createdAt').reverse().toArray()
    const q = query.trim().toLocaleLowerCase()
    return all.filter((c) => {
      if (c.deletedAt) return false
      if (!matchesTopic(c, topic)) return false
      if (troubleOnly && !leeches.has(c.id)) return false
      if (!q) return true
      return c.lemma.toLocaleLowerCase().includes(q)
    })
  }, [query, topic, troubleOnly, leeches], [])

  /** Every topic in use, from tags and from the old single category field. */
  const topics = useLiveQuery(
    async () => {
      const all = await db.concepts.toArray()
      const set = new Set<string>()
      for (const c of all) {
        if (c.deletedAt) continue
        if (c.category) set.add(c.category)
        for (const t of c.tags ?? []) set.add(t)
      }
      return [...set].sort()
    },
    [],
    [],
  )

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

  /**
   * Suspending keeps every row and every bit of FSRS state; it only stops the
   * word entering the queue. That is what you want for a word you keep
   * failing — pause it, fix the example, bring it back — and it is also how
   * delete works underneath, for the same replication reason.
   */
  async function handleSuspend(id: string) {
    const cards = await db.cards.where('conceptId').equals(id).toArray()
    if (cards.length === 0) return
    const now = Date.now()
    const anyActive = cards.some((c) => !c.suspended)
    await db.cards.bulkPut(
      cards.map((c) => ({ ...c, suspended: anyActive, updatedAt: now })),
    )
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
          <select value={topic} onChange={(e) => setTopic(e.target.value)}>
            <option value="all">All topics</option>
            {topics.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          <p className="muted small">{concepts.length} words</p>
          {leeches.size > 0 && (
            <button
              className={`chip ${troubleOnly ? 'chip-on' : ''}`}
              onClick={() => setTroubleOnly((v) => !v)}
              title={`Words failed ${LEECH_LAPSES} times or more`}
            >
              {troubleOnly ? '✓ ' : ''}
              {leeches.size} giving you trouble
            </button>
          )}
        </div>

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
                ) : leeches.has(c.id) ? (
                  <span
                    className="badge flag"
                    title={`Forgotten ${leeches.get(c.id)} times — rewrite the example, or pause it`}
                  >
                    trouble ×{leeches.get(c.id)}
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
                <button
                  className="link"
                  onClick={() => void handleSuspend(c.id)}
                  title="Take it out of the queue but keep its history"
                >
                  {paused.has(c.id) ? 'resume' : 'pause'}
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
