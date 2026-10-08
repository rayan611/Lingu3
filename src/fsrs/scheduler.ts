import {
  Rating,
  State,
  createEmptyCard,
  fsrs,
  type Card as FsrsCard,
  type FSRS,
  type Grade,
} from 'ts-fsrs'
import { db, compositeId, newId } from '../db/db'
import type { Card, Lang, ReviewLogRow, Settings } from '../db/types'

/** The four FSRS grades, in button order. */
export const GRADES = [
  Rating.Again,
  Rating.Hard,
  Rating.Good,
  Rating.Easy,
] as const

export const GRADE_LABELS: Record<number, string> = {
  [Rating.Again]: 'No idea',
  [Rating.Hard]: 'Not sure',
  [Rating.Good]: 'Knew it',
  [Rating.Easy]: 'Easy',
}

export const GRADE_HINTS: Record<number, string> = {
  [Rating.Again]: 'Wrong, or blank',
  [Rating.Hard]: 'Right, but it took effort',
  [Rating.Good]: 'Right, normal recall',
  [Rating.Easy]: 'Instant, felt trivial',
}

let cached: { scheduler: FSRS; retention: number } | null = null

export function getScheduler(requestRetention: number): FSRS {
  if (!cached || cached.retention !== requestRetention) {
    cached = {
      retention: requestRetention,
      scheduler: fsrs({ request_retention: requestRetention, enable_fuzz: true }),
    }
  }
  return cached.scheduler
}

// ---------------------------------------------------------------------------
// Conversion between the stored flat row and the ts-fsrs Card object
// ---------------------------------------------------------------------------

export function toFsrsCard(card: Card): FsrsCard {
  return {
    due: new Date(card.due),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsedDays,
    scheduled_days: card.scheduledDays,
    learning_steps: card.learningSteps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state as State,
    last_review: card.lastReview ? new Date(card.lastReview) : undefined,
  }
}

function fromFsrsCard(base: Card, f: FsrsCard): Card {
  return {
    ...base,
    due: f.due.getTime(),
    stability: f.stability,
    difficulty: f.difficulty,
    elapsedDays: f.elapsed_days,
    scheduledDays: f.scheduled_days,
    learningSteps: f.learning_steps,
    reps: f.reps,
    lapses: f.lapses,
    state: f.state,
    lastReview: f.last_review ? f.last_review.getTime() : undefined,
    updatedAt: Date.now(),
  }
}

export function makeCard(conceptId: string, lang: Lang, now = new Date()): Card {
  const empty = createEmptyCard(now)
  return fromFsrsCard(
    {
      id: compositeId(conceptId, lang),
      conceptId,
      lang,
      due: 0,
      stability: 0,
      difficulty: 0,
      elapsedDays: 0,
      scheduledDays: 0,
      learningSteps: 0,
      reps: 0,
      lapses: 0,
      state: State.New,
      updatedAt: 0,
    },
    empty,
  )
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

/**
 * Grade one (concept, language) card. Each language is scheduled completely
 * independently — this is what keeps an easy English item from inheriting a
 * hard German item's interval, and what lets a language be switched off and
 * resume at the right interval months later instead of restarting.
 *
 * Writes the card and its log row in one transaction so a crash mid-review
 * can't leave a card advanced with no history behind it.
 */
export async function gradeCard(
  card: Card,
  grade: Grade,
  settings: Settings,
  now = new Date(),
): Promise<Card> {
  const scheduler = getScheduler(settings.requestRetention)
  const { card: next, log } = scheduler.next(toFsrsCard(card), now, grade)
  const updated = fromFsrsCard(card, next)

  const logRow: ReviewLogRow = {
    id: newId(),
    cardId: card.id,
    conceptId: card.conceptId,
    lang: card.lang,
    grade: log.rating,
    state: log.state,
    due: log.due.getTime(),
    stability: log.stability,
    difficulty: log.difficulty,
    elapsedDays: log.elapsed_days,
    lastElapsedDays: log.last_elapsed_days,
    scheduledDays: log.scheduled_days,
    reviewedAt: now.getTime(),
  }

  await db.transaction('rw', db.cards, db.reviewLog, async () => {
    await db.cards.put(updated)
    await db.reviewLog.add(logRow)
  })

  return updated
}

/** Preview of the interval each button would produce, for the button labels. */
export function previewIntervals(
  card: Card,
  settings: Settings,
  now = new Date(),
): Record<number, string> {
  const scheduler = getScheduler(settings.requestRetention)
  const preview = scheduler.repeat(toFsrsCard(card), now)
  const out: Record<number, string> = {}
  for (const grade of GRADES) {
    out[grade] = formatInterval(preview[grade].card.due.getTime() - now.getTime())
  }
  return out
}

export function formatInterval(ms: number): string {
  const minutes = Math.round(ms / 60000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d`
  const months = days / 30.4
  if (months < 12) return `${months.toFixed(months < 10 ? 1 : 0)}mo`
  return `${(days / 365).toFixed(1)}y`
}
