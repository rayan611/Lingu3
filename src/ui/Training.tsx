import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { matchesTopic } from '../fsrs/queue'
import type { Concept, Settings } from '../db/types'
import { WordCard } from './WordCard'

type Sort = 'added' | 'oldest' | 'hardest' | 'alpha'

const SORT_LABELS: Record<Sort, string> = {
  added: 'Newest first',
  oldest: 'Oldest first',
  hardest: 'Hardest first',
  alpha: 'A–Z',
}

/**
 * Training: step through words without being asked anything.
 *
 * The hard rule here is that nothing in this screen touches FSRS state. No
 * grades, no review log, no card writes. If browsing counted as a review,
 * every interval would quietly inflate and the scheduler would stop meaning
 * anything — which is the same failure as one card carrying three languages'
 * answers, just arriving from the other direction.
 *
 * The native-language gloss of the example is shown here. It is hidden during
 * a test, where it would hand you the answer; here, reading it is the point.
 */
export function Training({ settings }: { settings: Settings }) {
  const [topic, setTopic] = useState('all')
  const [sort, setSort] = useState<Sort>('added')
  const [index, setIndex] = useState(0)

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

  /**
   * Difficulty comes straight off the FSRS cards that already exist — reading
   * it costs nothing and needs no new field. A word's difficulty is the worst
   * among its active languages, which is the one that will keep pulling it
   * forward in the queue anyway.
   */
  const words = useLiveQuery(
    async () => {
      const concepts = await db.concepts.orderBy('createdAt').reverse().toArray()
      const live = concepts.filter(
        (c) => !c.deletedAt && matchesTopic(c, topic === 'all' ? null : topic),
      )
      if (sort !== 'hardest') return { list: live, difficulty: new Map<string, number>() }

      const cards = await db.cards
        .where('lang')
        .anyOf(settings.activeLangs as string[])
        .toArray()
      const difficulty = new Map<string, number>()
      for (const card of cards) {
        if (card.suspended) continue
        difficulty.set(
          card.conceptId,
          Math.max(difficulty.get(card.conceptId) ?? 0, card.difficulty),
        )
      }
      return { list: live, difficulty }
    },
    [topic, sort, settings.activeLangs],
    { list: [] as Concept[], difficulty: new Map<string, number>() },
  )

  const ordered = useMemo(() => {
    const list = [...words.list]
    if (sort === 'oldest') list.reverse()
    else if (sort === 'alpha')
      list.sort((a, b) => a.lemma.localeCompare(b.lemma))
    else if (sort === 'hardest')
      list.sort(
        (a, b) =>
          (words.difficulty.get(b.id) ?? 0) - (words.difficulty.get(a.id) ?? 0),
      )
    return list
  }, [words, sort])

  // Changing the filter should not leave you pointing past the end of the list.
  useEffect(() => {
    setIndex(0)
  }, [topic, sort])

  const current = ordered[Math.min(index, Math.max(0, ordered.length - 1))]

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return
      if (e.target instanceof HTMLSelectElement) return
      if (e.key === 'ArrowRight' || e.code === 'Space') {
        e.preventDefault()
        setIndex((i) => Math.min(i + 1, ordered.length - 1))
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        setIndex((i) => Math.max(0, i - 1))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ordered.length])

  if (ordered.length === 0) {
    return (
      <div className="stack">
        <div className="panel">
          <h2>Training</h2>
          <p className="muted">
            {topic === 'all'
              ? 'No words yet. Add some on the Add tab.'
              : `Nothing tagged “${topic}”.`}
          </p>
          {topic !== 'all' && (
            <button onClick={() => setTopic('all')}>Show all topics</button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="stack">
      <div className="panel">
        <div className="topic-bar">
          <label className="field inline">
            <span className="muted small">Topic</span>
            <select value={topic} onChange={(e) => setTopic(e.target.value)}>
              <option value="all">All topics</option>
              {topics.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="field inline">
            <span className="muted small">Order</span>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as Sort)}
            >
              {(Object.keys(SORT_LABELS) as Sort[]).map((s) => (
                <option key={s} value={s}>
                  {SORT_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="muted small">
          Reading only — nothing here changes your review schedule.
        </p>
      </div>

      {current && <WordCard conceptId={current.id} settings={settings} />}

      <div className="panel training-nav">
        <button onClick={() => setIndex((i) => Math.max(0, i - 1))} disabled={index === 0}>
          ← Previous
        </button>
        <span className="muted small">
          {Math.min(index + 1, ordered.length)} of {ordered.length}
        </span>
        <button
          className="primary"
          onClick={() => setIndex((i) => Math.min(i + 1, ordered.length - 1))}
          disabled={index >= ordered.length - 1}
        >
          Next →
        </button>
      </div>
    </div>
  )
}
