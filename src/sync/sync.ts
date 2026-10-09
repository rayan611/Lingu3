import { db, getMeta, setMeta } from '../db/db'
import { supabase } from '../auth/supabase'
import { DEFAULT_SETTINGS, type Card, type Concept, type Entry, type Lang, type ReviewLogRow, type Settings, type Story } from '../db/types'

/**
 * Last-write-wins sync against Supabase.
 *
 * The app never reads from here — it reads Dexie. This runs in the background
 * and reconciles. Three shapes of data, three strategies:
 *
 *   review log  append-only; rows are inserted and never updated, so it is the
 *               one table that physically cannot conflict
 *   everything  last-write-wins on `updated_at`; for a single person across
 *   else        two devices this is correct often enough that the cases it
 *               loses are ones you would not notice
 *
 * Deletes are soft (`deleted_at`), because a row removed on one device has to
 * be representable as a change the other device can receive.
 */

const CURSOR_PULL = 'sync.lastPulledAt'
const CURSOR_PUSH = 'sync.lastPushedAt'
const CURSOR_LOG = 'sync.lastLogPushedAt'

export interface SyncResult {
  pushed: number
  pulled: number
  at: number
  error?: string
}

const iso = (ms: number) => new Date(ms).toISOString()
const ms = (s: string | null | undefined) => (s ? new Date(s).getTime() : 0)

// --- row mapping -----------------------------------------------------------
// Postgres is snake_case, the client is camelCase. Keeping the translation in
// one place means a schema change breaks here loudly rather than in five
// scattered call sites.

type Row = Record<string, unknown>

const conceptOut = (c: Concept, userId: string): Row => ({
  id: c.id,
  user_id: userId,
  lemma: c.lemma,
  source_lang: c.sourceLang,
  pos: c.pos,
  category: c.category,
  tags: c.tags ?? [],
  notes: c.notes ?? null,
  created_at: iso(c.createdAt),
  updated_at: iso(c.updatedAt),
  deleted_at: c.deletedAt ? iso(c.deletedAt) : null,
})

const conceptIn = (r: Row): Concept => ({
  id: r.id as string,
  lemma: r.lemma as string,
  sourceLang: r.source_lang as Lang,
  pos: r.pos as Concept['pos'],
  category: r.category as Concept['category'],
  // Postgres gives back an empty array rather than null; an empty tag list and
  // no tag list mean the same thing here, so both normalise to undefined.
  tags: Array.isArray(r.tags) && r.tags.length ? (r.tags as string[]) : undefined,
  notes: (r.notes as string) ?? undefined,
  createdAt: ms(r.created_at as string),
  updatedAt: ms(r.updated_at as string),
  deletedAt: r.deleted_at ? ms(r.deleted_at as string) : undefined,
})

const entryOut = (e: Entry, userId: string): Row => ({
  id: e.id,
  user_id: userId,
  concept_id: e.conceptId,
  lang: e.lang,
  headword: e.headword,
  meaning: e.meaning,
  morphology: e.morphology ?? null,
  example: e.example ?? null,
  example_gloss: e.exampleGloss ?? null,
  notes: e.notes ?? null,
  updated_at: iso(e.updatedAt),
})

const entryIn = (r: Row): Entry => ({
  id: r.id as string,
  conceptId: r.concept_id as string,
  lang: r.lang as Lang,
  headword: r.headword as string,
  meaning: r.meaning as string,
  morphology: (r.morphology as Entry['morphology']) ?? undefined,
  example: (r.example as string) ?? undefined,
  exampleGloss: (r.example_gloss as string) ?? undefined,
  notes: (r.notes as string) ?? undefined,
  updatedAt: ms(r.updated_at as string),
})

const cardOut = (c: Card, userId: string): Row => ({
  id: c.id,
  user_id: userId,
  concept_id: c.conceptId,
  lang: c.lang,
  due: iso(c.due),
  stability: c.stability,
  difficulty: c.difficulty,
  elapsed_days: c.elapsedDays,
  scheduled_days: c.scheduledDays,
  learning_steps: c.learningSteps,
  reps: c.reps,
  lapses: c.lapses,
  state: c.state,
  last_review: c.lastReview ? iso(c.lastReview) : null,
  suspended: c.suspended ?? false,
  updated_at: iso(c.updatedAt),
})

const cardIn = (r: Row): Card => ({
  id: r.id as string,
  conceptId: r.concept_id as string,
  lang: r.lang as Lang,
  due: ms(r.due as string),
  stability: Number(r.stability),
  difficulty: Number(r.difficulty),
  elapsedDays: Number(r.elapsed_days),
  scheduledDays: Number(r.scheduled_days),
  learningSteps: Number(r.learning_steps),
  reps: Number(r.reps),
  lapses: Number(r.lapses),
  state: Number(r.state),
  lastReview: r.last_review ? ms(r.last_review as string) : undefined,
  suspended: Boolean(r.suspended),
  updatedAt: ms(r.updated_at as string),
})

const storyOut = (s: Story, userId: string): Row => ({
  id: s.id,
  user_id: userId,
  title: s.title,
  body: s.body,
  lang: s.lang,
  genre: s.genre,
  topics: s.topics ?? [],
  word_count: s.wordCount,
  known_count: s.knownCount,
  unknown_words: s.unknownWords ?? [],
  glossary: s.glossary ?? null,
  created_at: iso(s.createdAt),
  updated_at: iso(s.updatedAt),
  deleted_at: s.deletedAt ? iso(s.deletedAt) : null,
})

const storyIn = (r: Row): Story => ({
  id: r.id as string,
  title: (r.title as string) ?? '',
  body: (r.body as string) ?? '',
  lang: r.lang as Lang,
  genre: (r.genre as string) ?? 'fun',
  topics: Array.isArray(r.topics) ? (r.topics as string[]) : [],
  wordCount: Number(r.word_count ?? 0),
  knownCount: Number(r.known_count ?? 0),
  unknownWords: Array.isArray(r.unknown_words) ? (r.unknown_words as string[]) : [],
  glossary: (r.glossary as Story['glossary']) ?? undefined,
  createdAt: ms(r.created_at as string),
  updatedAt: ms(r.updated_at as string),
  deletedAt: r.deleted_at ? ms(r.deleted_at as string) : undefined,
})

const logOut = (l: ReviewLogRow, userId: string): Row => ({
  id: l.id,
  user_id: userId,
  card_id: l.cardId,
  concept_id: l.conceptId,
  lang: l.lang,
  grade: l.grade,
  state: l.state,
  due: iso(l.due),
  stability: l.stability,
  difficulty: l.difficulty,
  elapsed_days: l.elapsedDays,
  last_elapsed_days: l.lastElapsedDays,
  scheduled_days: l.scheduledDays,
  reviewed_at: iso(l.reviewedAt),
})

// --- sync ------------------------------------------------------------------

/**
 * How long a sync may hold the lock before the next attempt is allowed to
 * ignore it. Longer than STEP_TIMEOUT_MS so the timeout normally wins; this is
 * only reached when the timer itself never fired.
 */
export const STALE_LOCK_MS = 60_000

/** How long a single push or pull may take before it is abandoned. */
export const STEP_TIMEOUT_MS = 45_000

/**
 * A mutex that cannot be held forever.
 *
 * Kept as its own object rather than two module-level booleans so the
 * staleness rule can be exercised by a check with fake timestamps, instead of
 * a test that waits a real minute.
 */
export class ExpiringLock {
  private held = false
  private since = 0

  constructor(private readonly staleAfterMs: number) {}

  /** True if the lock was taken; false if someone else legitimately holds it. */
  acquire(now = Date.now()): boolean {
    if (this.held && now - this.since < this.staleAfterMs) return false
    this.held = true
    this.since = now
    return true
  }

  release(): void {
    this.held = false
  }

  isHeld(now = Date.now()): boolean {
    return this.held && now - this.since < this.staleAfterMs
  }
}

const lock = new ExpiringLock(STALE_LOCK_MS)

/**
 * Bounds a promise that may never settle.
 *
 * The lock below is released in a `finally`, which makes it exception-safe but
 * not hang-safe: Supabase's fetch has no default timeout, and a request issued
 * as the tab is backgrounded on a phone can be frozen mid-flight and neither
 * resolve nor reject. Without this the lock would be held for the rest of the
 * page's life and every later sync would answer `already running`.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms)
    }),
  ])
}

/**
 * Moves a cursor forward, never back.
 *
 * A step that timed out is abandoned but keeps executing, and may finish after
 * a later sync has already advanced the cursor past its own `startedAt`.
 * Writing that older value would re-send a window of rows on the next push —
 * harmless, since every write is an idempotent upsert, but pointless.
 */
export async function advanceCursor(key: string, to: number): Promise<void> {
  const current = Number(await getMeta(key)) || 0
  if (to > current) await setMeta(key, to)
}

export async function sync(userId: string): Promise<SyncResult> {
  const at = Date.now()
  if (!navigator.onLine) return { pushed: 0, pulled: 0, at, error: 'offline' }
  // One at a time. Two overlapping syncs would race on the cursors and could
  // skip a window of changes permanently. The lock expires, though: a held
  // lock older than STALE_LOCK_MS belongs to a run that is never coming back.
  if (!lock.acquire(at)) {
    return { pushed: 0, pulled: 0, at, error: 'already running' }
  }

  // Aborting is what actually stops the request; the timeout only stops us
  // waiting for it. Both, because a frozen tab fires neither.
  const controller = new AbortController()
  const abort = setTimeout(() => controller.abort(), STEP_TIMEOUT_MS * 2)

  try {
    const pushed = await withTimeout(
      push(userId, controller.signal),
      STEP_TIMEOUT_MS,
      'push',
    )
    const pulled = await withTimeout(
      pull(userId, controller.signal),
      STEP_TIMEOUT_MS,
      'pull',
    )
    return { pushed, pulled, at: Date.now() }
  } catch (err) {
    controller.abort()
    return {
      pushed: 0,
      pulled: 0,
      at: Date.now(),
      error: err instanceof Error ? err.message : String(err),
    }
  } finally {
    clearTimeout(abort)
    lock.release()
  }
}

/** Whether a sync is in flight right now — for the UI and for the checks. */
export function syncLockHeld(): boolean {
  return lock.isHeld()
}

async function push(userId: string, signal: AbortSignal): Promise<number> {
  const sb = supabase()
  const since = Number(await getMeta(CURSOR_PUSH)) || 0
  // One second of overlap: clocks and transaction boundaries mean a row
  // written in the same millisecond as the cursor can otherwise be missed.
  const from = Math.max(0, since - 1000)
  const startedAt = Date.now()
  let count = 0

  const concepts = await db.concepts.filter((c) => c.updatedAt > from).toArray()
  if (concepts.length) {
    const { error } = await sb
      .from('concepts')
      .upsert(concepts.map((c) => conceptOut(c, userId)))
      .abortSignal(signal)
    if (error) throw new Error(`concepts: ${error.message}`)
    count += concepts.length
  }

  const entries = await db.entries.filter((e) => e.updatedAt > from).toArray()
  if (entries.length) {
    const { error } = await sb
      .from('entries')
      .upsert(entries.map((e) => entryOut(e, userId)))
      .abortSignal(signal)
    if (error) throw new Error(`entries: ${error.message}`)
    count += entries.length
  }

  const cards = await db.cards.filter((c) => c.updatedAt > from).toArray()
  if (cards.length) {
    const { error } = await sb
      .from('cards')
      .upsert(cards.map((c) => cardOut(c, userId)))
      .abortSignal(signal)
    if (error) throw new Error(`cards: ${error.message}`)
    count += cards.length
  }

  const stories = await db.stories.filter((s) => s.updatedAt > from).toArray()
  if (stories.length) {
    const { error } = await sb
      .from('stories')
      .upsert(stories.map((s) => storyOut(s, userId)))
      .abortSignal(signal)
    if (error) throw new Error(`stories: ${error.message}`)
    count += stories.length
  }

  // Append-only: push by reviewedAt, ignore duplicates rather than updating.
  const logSince = Number(await getMeta(CURSOR_LOG)) || 0
  const logs = await db.reviewLog
    .filter((l) => l.reviewedAt > Math.max(0, logSince - 1000))
    .toArray()
  if (logs.length) {
    const { error } = await sb
      .from('review_log')
      .upsert(logs.map((l) => logOut(l, userId)), { ignoreDuplicates: true })
      .abortSignal(signal)
    if (error) throw new Error(`review_log: ${error.message}`)
    count += logs.length
  }
  await advanceCursor(CURSOR_LOG, startedAt)

  const settings = await db.settings.get('singleton')
  if (settings && settings.updatedAt > from) {
    const { error } = await sb.from('user_settings').upsert({
      user_id: userId,
      display_name: settings.displayName ?? null,
      native_lang: settings.nativeLang,
      target_langs: settings.targetLangs,
      active_langs: settings.activeLangs,
      daily_new_limit: settings.dailyNewLimit,
      daily_review_limit: settings.dailyReviewLimit,
      request_retention: settings.requestRetention,
      updated_at: iso(settings.updatedAt),
    }).abortSignal(signal)
    if (error) throw new Error(`settings: ${error.message}`)
    count += 1
  }

  // Only advance the cursor once everything landed, so a mid-push failure
  // retries the whole window instead of losing part of it.
  await advanceCursor(CURSOR_PUSH, startedAt)
  return count
}

async function pull(userId: string, signal: AbortSignal): Promise<number> {
  const sb = supabase()
  const since = Number(await getMeta(CURSOR_PULL)) || 0
  const from = iso(Math.max(0, since - 1000))
  const startedAt = Date.now()
  let count = 0

  const { data: concepts, error: cErr } = await sb
    .from('concepts')
    .select('*')
    .eq('user_id', userId)
    .gt('updated_at', from)
    .abortSignal(signal)
  if (cErr) throw new Error(`concepts: ${cErr.message}`)
  count += await mergeInto(db.concepts, (concepts ?? []).map(conceptIn))

  const { data: entries, error: eErr } = await sb
    .from('entries')
    .select('*')
    .eq('user_id', userId)
    .gt('updated_at', from)
    .abortSignal(signal)
  if (eErr) throw new Error(`entries: ${eErr.message}`)
  count += await mergeInto(db.entries, (entries ?? []).map(entryIn))

  const { data: cards, error: kErr } = await sb
    .from('cards')
    .select('*')
    .eq('user_id', userId)
    .gt('updated_at', from)
    .abortSignal(signal)
  if (kErr) throw new Error(`cards: ${kErr.message}`)
  count += await mergeInto(db.cards, (cards ?? []).map(cardIn))

  const { data: stories, error: sErr } = await sb
    .from('stories')
    .select('*')
    .eq('user_id', userId)
    .gt('updated_at', from)
    .abortSignal(signal)
  if (sErr) throw new Error(`stories: ${sErr.message}`)
  count += await mergeInto(db.stories, (stories ?? []).map(storyIn))

  const { data: remoteSettings } = await sb
    .from('user_settings')
    .select('*')
    .eq('user_id', userId)
    .abortSignal(signal)
    .maybeSingle()
  if (remoteSettings) {
    const local = await db.settings.get('singleton')
    const remoteAt = ms(remoteSettings.updated_at as string)
    if (!local || remoteAt > local.updatedAt) {
      const merged: Settings = {
        ...DEFAULT_SETTINGS,
        ...local,
        id: 'singleton',
        displayName: (remoteSettings.display_name as string) ?? undefined,
        nativeLang: remoteSettings.native_lang as Lang,
        targetLangs: remoteSettings.target_langs as Lang[],
        activeLangs: remoteSettings.active_langs as Lang[],
        dailyNewLimit: Number(remoteSettings.daily_new_limit),
        dailyReviewLimit: Number(remoteSettings.daily_review_limit),
        requestRetention: Number(remoteSettings.request_retention),
        updatedAt: remoteAt,
      }
      await db.settings.put(merged)
      count += 1
    }
  }

  await advanceCursor(CURSOR_PULL, startedAt)
  return count
}

/**
 * Writes remote rows that are newer than what we hold. The comparison is the
 * whole of last-write-wins: a row the other device changed later wins, a row
 * we changed later is left alone and goes out on the next push.
 */
async function mergeInto<T extends { id: string; updatedAt: number }>(
  table: { bulkGet: (ids: string[]) => Promise<(T | undefined)[]>; bulkPut: (rows: T[]) => Promise<unknown> },
  remote: T[],
): Promise<number> {
  if (remote.length === 0) return 0
  const locals = await table.bulkGet(remote.map((r) => r.id))
  const winners = remote.filter((r, i) => {
    const local = locals[i]
    return !local || r.updatedAt > local.updatedAt
  })
  if (winners.length) await table.bulkPut(winners)
  return winners.length
}

/** Clears cursors so the next sync re-reads everything. For "resync" in the UI. */
export async function resetSyncCursors() {
  await Promise.all([
    setMeta(CURSOR_PULL, 0),
    setMeta(CURSOR_PUSH, 0),
    setMeta(CURSOR_LOG, 0),
  ])
}
