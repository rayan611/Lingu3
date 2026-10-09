import { State } from 'ts-fsrs'
import { db } from '../db/db'
import type { Lang, Settings } from '../db/types'

/**
 * Everything on the Profile screen, computed from rows that already exist.
 *
 * Nothing here is stored. Review history is append-only and concepts carry
 * `createdAt`, so every number below is derivable — and a derived number
 * cannot drift out of step with the thing it counts, which a cached one can.
 */

export const DAY = 86_400_000

export function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export interface LangStat {
  lang: Lang
  cards: number
  due: number
  /** Cards FSRS considers learned rather than still being introduced. */
  inReview: number
  /** Mean stability in days, over cards that have one. */
  avgStability: number
  lapses: number
  active: boolean
}

export interface Stats {
  words: number
  /** Concepts with at least one card past the New state. */
  wordsStarted: number
  reviews: number
  reviewsToday: number
  streak: number
  longestStreak: number
  /** Cumulative word count, one point per day, oldest first. */
  growth: { day: number; total: number }[]
  /** Reviews per day for the heatmap, oldest first. */
  heatmap: { day: number; count: number }[]
  perLang: LangStat[]
  firstActivity: number | null
}

export async function computeStats(
  settings: Settings,
  days = 182,
): Promise<Stats> {
  const [concepts, cards, logs] = await Promise.all([
    db.concepts.toArray(),
    db.cards.toArray(),
    db.reviewLog.toArray(),
  ])

  const live = concepts.filter((c) => !c.deletedAt)
  const liveIds = new Set(live.map((c) => c.id))
  const now = Date.now()
  const today = startOfDay(now)

  // --- per language --------------------------------------------------------
  const langs = settings.targetLangs
  const perLang: LangStat[] = langs.map((lang) => {
    const mine = cards.filter(
      (c) => c.lang === lang && !c.suspended && liveIds.has(c.conceptId),
    )
    const withStability = mine.filter((c) => c.stability > 0)
    return {
      lang,
      cards: mine.length,
      due: mine.filter((c) => c.due <= now).length,
      inReview: mine.filter((c) => c.state !== State.New).length,
      avgStability: withStability.length
        ? withStability.reduce((a, c) => a + c.stability, 0) /
          withStability.length
        : 0,
      lapses: mine.reduce((a, c) => a + c.lapses, 0),
      active: settings.activeLangs.includes(lang),
    }
  })

  // --- review activity by day ---------------------------------------------
  const byDay = new Map<number, number>()
  for (const log of logs) {
    const day = startOfDay(log.reviewedAt)
    byDay.set(day, (byDay.get(day) ?? 0) + 1)
  }

  const heatmap: { day: number; count: number }[] = []
  for (let i = days - 1; i >= 0; i--) {
    const day = today - i * DAY
    heatmap.push({ day, count: byDay.get(day) ?? 0 })
  }

  // Streaks, counted backwards from today. Today not being reviewed yet does
  // not break a streak — it is still today.
  let streak = 0
  for (let i = 0; ; i++) {
    const day = today - i * DAY
    if ((byDay.get(day) ?? 0) > 0) streak++
    else if (i > 0) break
    else continue
  }

  let longestStreak = 0
  let run = 0
  const sortedDays = [...byDay.keys()].sort((a, b) => a - b)
  for (let i = 0; i < sortedDays.length; i++) {
    if (i > 0 && sortedDays[i] - sortedDays[i - 1] === DAY) run++
    else run = 1
    longestStreak = Math.max(longestStreak, run)
  }

  // --- words over time -----------------------------------------------------
  const addedPerDay = new Map<number, number>()
  for (const c of live) {
    const day = startOfDay(c.createdAt)
    addedPerDay.set(day, (addedPerDay.get(day) ?? 0) + 1)
  }
  const firstDay = live.length
    ? startOfDay(Math.min(...live.map((c) => c.createdAt)))
    : today
  const from = Math.max(firstDay, today - (days - 1) * DAY)
  // Everything added before the window still counts — the line starts at the
  // total you already had, not at zero.
  let running = live.filter((c) => startOfDay(c.createdAt) < from).length
  const growth: { day: number; total: number }[] = []
  for (let day = from; day <= today; day += DAY) {
    running += addedPerDay.get(day) ?? 0
    growth.push({ day, total: running })
  }

  const startedIds = new Set(
    cards.filter((c) => c.state !== State.New).map((c) => c.conceptId),
  )

  return {
    words: live.length,
    wordsStarted: live.filter((c) => startedIds.has(c.id)).length,
    reviews: logs.length,
    reviewsToday: byDay.get(today) ?? 0,
    streak,
    longestStreak,
    growth,
    heatmap,
    perLang,
    firstActivity: logs.length
      ? Math.min(...logs.map((l) => l.reviewedAt))
      : null,
  }
}
