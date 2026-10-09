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

let running = false

export async function sync(userId: string): Promise<SyncResult> {
  const at = Date.now()
  if (!navigator.onLine) return { pushed: 0, pulled: 0, at, error: 'offline' }
  // One at a time. Two overlapping syncs would race on the cursors and could
  // skip a window of changes permanently.
  if (running) return { pushed: 0, pulled: 0, at, error: 'already running' }
  running = true

  try {
    const pushed = await push(userId)
    const pulled = await pull(userId)
    return { pushed, pulled, at: Date.now() }
  } catch (err) {
    return {
      pushed: 0,
      pulled: 0,
      at: Date.now(),
      error: err instanceof Error ? err.message : String(err),
    }
  } finally {
    running = false
  }
}

async function push(userId: string): Promise<number> {
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
    if (error) throw new Error(`concepts: ${error.message}`)
    count += concepts.length
  }

  const entries = await db.entries.filter((e) => e.updatedAt > from).toArray()
  if (entries.length) {
    const { error } = await sb
      .from('entries')
      .upsert(entries.map((e) => entryOut(e, userId)))
    if (error) throw new Error(`entries: ${error.message}`)
    count += entries.length
  }

  const cards = await db.cards.filter((c) => c.updatedAt > from).toArray()
  if (cards.length) {
    const { error } = await sb.from('cards').upsert(cards.map((c) => cardOut(c, userId)))
    if (error) throw new Error(`cards: ${error.message}`)
    count += cards.length
  }

  const stories = await db.stories.filter((s) => s.updatedAt > from).toArray()
  if (stories.length) {
    const { error } = await sb
      .from('stories')
      .upsert(stories.map((s) => storyOut(s, userId)))
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
    if (error) throw new Error(`review_log: ${error.message}`)
    count += logs.length
  }
  await setMeta(CURSOR_LOG, startedAt)

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
    })
    if (error) throw new Error(`settings: ${error.message}`)
    count += 1
  }

  // Only advance the cursor once everything landed, so a mid-push failure
  // retries the whole window instead of losing part of it.
  await setMeta(CURSOR_PUSH, startedAt)
  return count
}

async function pull(userId: string): Promise<number> {
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
  if (cErr) throw new Error(`concepts: ${cErr.message}`)
  count += await mergeInto(db.concepts, (concepts ?? []).map(conceptIn))

  const { data: entries, error: eErr } = await sb
    .from('entries')
    .select('*')
    .eq('user_id', userId)
    .gt('updated_at', from)
  if (eErr) throw new Error(`entries: ${eErr.message}`)
  count += await mergeInto(db.entries, (entries ?? []).map(entryIn))

  const { data: cards, error: kErr } = await sb
    .from('cards')
    .select('*')
    .eq('user_id', userId)
    .gt('updated_at', from)
  if (kErr) throw new Error(`cards: ${kErr.message}`)
  count += await mergeInto(db.cards, (cards ?? []).map(cardIn))

  const { data: stories, error: sErr } = await sb
    .from('stories')
    .select('*')
    .eq('user_id', userId)
    .gt('updated_at', from)
  if (sErr) throw new Error(`stories: ${sErr.message}`)
  count += await mergeInto(db.stories, (stories ?? []).map(storyIn))

  const { data: remoteSettings } = await sb
    .from('user_settings')
    .select('*')
    .eq('user_id', userId)
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

  await setMeta(CURSOR_PULL, startedAt)
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
