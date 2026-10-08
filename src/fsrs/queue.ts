import { State } from 'ts-fsrs'
import { db } from '../db/db'
import type { Card, Concept, Entry, Lang, Settings } from '../db/types'

export interface QueueItem {
  concept: Concept
  /** Entries for the native language plus every active target, in priority order. */
  entries: Entry[]
  /** One card per active target language, in the same priority order. */
  cards: Card[]
  /** The earliest due time among active cards — what orders the queue. */
  dueAt: number
  isNew: boolean
}

function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * How many distinct concepts were introduced today, so the new-card limit
 * counts words rather than cards. Introducing one word in three languages is
 * one new word, not three.
 */
async function newConceptsToday(): Promise<number> {
  const since = startOfDay(Date.now())
  const rows = await db.reviewLog
    .where('reviewedAt')
    .aboveOrEqual(since)
    .filter((r) => r.state === State.New)
    .toArray()
  return new Set(rows.map((r) => r.conceptId)).size
}

/**
 * Builds the review queue.
 *
 * A concept enters the queue when *any* of its active-language cards is due,
 * and the whole concept is then shown with every active language stacked in
 * priority order. In practice this reproduces the "worst answer drives the
 * card" rule you wanted: the language you keep rating badly has the shortest
 * interval, so it is the one that keeps pulling the card forward.
 *
 * Languages that are switched off are excluded here and nowhere else — their
 * cards keep their state untouched and resume correctly when switched back on.
 */
export async function buildQueue(
  settings: Settings,
  limit = 60,
): Promise<QueueItem[]> {
  const active = settings.targetLangs.filter((l) =>
    settings.activeLangs.includes(l),
  )
  if (active.length === 0) return []

  const now = Date.now()

  const dueCards = await db.cards
    .where('lang')
    .anyOf(active as string[])
    .filter((c) => !c.suspended && c.due <= now)
    .toArray()

  if (dueCards.length === 0) return []

  // Group due cards by concept and find each concept's earliest due time.
  const byConcept = new Map<string, { dueAt: number; anyNew: boolean }>()
  for (const card of dueCards) {
    const prev = byConcept.get(card.conceptId)
    const isNew = card.state === State.New
    if (!prev) {
      byConcept.set(card.conceptId, { dueAt: card.due, anyNew: isNew })
    } else {
      prev.dueAt = Math.min(prev.dueAt, card.due)
      prev.anyNew = prev.anyNew || isNew
    }
  }

  const conceptIds = [...byConcept.keys()]
  const concepts = await db.concepts.bulkGet(conceptIds)

  // Apply the daily limits. New words and reviews get separate budgets so a
  // backlog of reviews never blocks learning and vice versa.
  const introducedToday = await newConceptsToday()
  let newBudget = Math.max(0, settings.dailyNewLimit - introducedToday)
  let reviewBudget = settings.dailyReviewLimit

  const candidates = concepts
    .map((concept, i) => {
      if (!concept || concept.deletedAt) return null
      const meta = byConcept.get(conceptIds[i])!
      return { concept, dueAt: meta.dueAt, isNew: meta.anyNew }
    })
    .filter((x): x is { concept: Concept; dueAt: number; isNew: boolean } => !!x)
    .sort((a, b) => {
      // Reviews before new words: clearing what is already decaying beats
      // adding more of it.
      if (a.isNew !== b.isNew) return a.isNew ? 1 : -1
      return a.dueAt - b.dueAt
    })

  const selected: typeof candidates = []
  for (const c of candidates) {
    if (selected.length >= limit) break
    if (c.isNew) {
      if (newBudget <= 0) continue
      newBudget--
    } else {
      if (reviewBudget <= 0) continue
      reviewBudget--
    }
    selected.push(c)
  }

  if (selected.length === 0) return []

  const ids = selected.map((s) => s.concept.id)
  const [allEntries, allCards] = await Promise.all([
    db.entries.where('conceptId').anyOf(ids).toArray(),
    db.cards.where('conceptId').anyOf(ids).toArray(),
  ])

  // Display order: native language first (the prompt), then targets by priority.
  const displayOrder = [settings.nativeLang, ...active]

  return selected.map(({ concept, dueAt, isNew }) => {
    const entries = allEntries
      .filter((e) => e.conceptId === concept.id && displayOrder.includes(e.lang))
      .sort(
        (a, b) => displayOrder.indexOf(a.lang) - displayOrder.indexOf(b.lang),
      )
    const cards = allCards
      .filter(
        (c) => c.conceptId === concept.id && active.includes(c.lang) && !c.suspended,
      )
      .sort((a, b) => active.indexOf(a.lang) - active.indexOf(b.lang))
    return { concept, entries, cards, dueAt, isNew }
  })
}

export interface QueueCounts {
  due: number
  newWords: number
  total: number
  perLang: Record<string, number>
}

export async function queueCounts(settings: Settings): Promise<QueueCounts> {
  const active = settings.targetLangs.filter((l) =>
    settings.activeLangs.includes(l),
  )
  const now = Date.now()
  const cards =
    active.length === 0
      ? []
      : await db.cards
          .where('lang')
          .anyOf(active as string[])
          .filter((c) => !c.suspended && c.due <= now)
          .toArray()

  const perLang: Record<string, number> = {}
  for (const l of active) perLang[l] = 0
  const newConcepts = new Set<string>()
  const dueConcepts = new Set<string>()

  for (const c of cards) {
    perLang[c.lang] = (perLang[c.lang] ?? 0) + 1
    if (c.state === State.New) newConcepts.add(c.conceptId)
    else dueConcepts.add(c.conceptId)
  }

  return {
    due: dueConcepts.size,
    newWords: newConcepts.size,
    total: new Set(cards.map((c) => c.conceptId)).size,
    perLang,
  }
}

export function isActive(lang: Lang, settings: Settings): boolean {
  return settings.activeLangs.includes(lang)
}
