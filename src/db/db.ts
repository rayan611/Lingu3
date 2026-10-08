import Dexie, { type Table } from 'dexie'
import {
  DEFAULT_SETTINGS,
  type Card,
  type Concept,
  type Entry,
  type PendingExpansion,
  type ReviewLogRow,
  type Settings,
} from './types'

/** Sync cursors and other bookkeeping. One row per key. */
export interface MetaRow {
  key: string
  value: string | number | null
}

/**
 * Local-first store. The app only ever reads and writes here; the remote is a
 * background push/pull on top. Every mutable row carries `updatedAt`, which is
 * what last-write-wins sync resolves on.
 *
 * One database per signed-in user. Two people sharing a laptop get genuinely
 * separate stores rather than a shared one filtered by id — which is both
 * simpler and impossible to get wrong by forgetting a `where` clause.
 */
export class LinguaDB extends Dexie {
  concepts!: Table<Concept, string>
  entries!: Table<Entry, string>
  cards!: Table<Card, string>
  reviewLog!: Table<ReviewLogRow, string>
  pending!: Table<PendingExpansion, string>
  settings!: Table<Settings, string>
  meta!: Table<MetaRow, string>

  constructor(dbName: string) {
    super(dbName)
    this.version(1).stores({
      concepts: 'id, lemma, sourceLang, pos, category, updatedAt, deletedAt',
      entries: 'id, conceptId, lang, headword, updatedAt, [conceptId+lang]',
      // `[lang+due]` is the index the review queue runs on.
      cards: 'id, conceptId, lang, due, state, updatedAt, [lang+due]',
      reviewLog: 'id, cardId, conceptId, lang, reviewedAt',
      pending: 'id, conceptId, createdAt',
      settings: 'id',
      meta: 'key',
    })
  }
}

/** Database name for a user, or the local-only store when signed out. */
function dbNameFor(userId: string | null): string {
  return userId ? `lingua-${userId}` : 'lingua-local'
}

// `let` plus a live export binding: modules that `import { db }` always see the
// current database, so switching user does not require threading a handle
// through every call site.
export let db: LinguaDB = new LinguaDB(dbNameFor(null))
let currentDbName = db.name

/**
 * Point the app at a user's database. Returns true when the database actually
 * changed, which is the signal for the UI to remount so no stale query results
 * survive the switch.
 */
export async function openForUser(userId: string | null): Promise<boolean> {
  const next = dbNameFor(userId)
  if (next === currentDbName) return false
  try {
    db.close()
  } catch {
    /* already closed */
  }
  db = new LinguaDB(next)
  currentDbName = next
  await db.open()
  return true
}

/**
 * Moves anything added before signing in into the signed-in user's store, then
 * empties the local one. Without this, words added on first run would vanish
 * the moment an account is created.
 */
export async function adoptLocalData(): Promise<number> {
  const local = new LinguaDB(dbNameFor(null))
  try {
    await local.open()
    const [concepts, entries, cards, reviewLog, pending] = await Promise.all([
      local.concepts.toArray(),
      local.entries.toArray(),
      local.cards.toArray(),
      local.reviewLog.toArray(),
      local.pending.toArray(),
    ])
    if (concepts.length === 0) return 0

    await db.transaction(
      'rw',
      db.concepts, db.entries, db.cards, db.reviewLog, db.pending,
      async () => {
        // bulkPut, not bulkAdd: re-running this must not explode on rows that
        // already made it across.
        await db.concepts.bulkPut(concepts)
        await db.entries.bulkPut(entries)
        await db.cards.bulkPut(cards)
        await db.reviewLog.bulkPut(reviewLog)
        await db.pending.bulkPut(pending)
      },
    )

    await local.transaction(
      'rw',
      local.concepts, local.entries, local.cards, local.reviewLog, local.pending,
      async () => {
        await Promise.all([
          local.concepts.clear(),
          local.entries.clear(),
          local.cards.clear(),
          local.reviewLog.clear(),
          local.pending.clear(),
        ])
      },
    )
    return concepts.length
  } finally {
    local.close()
  }
}

export async function getMeta(key: string): Promise<string | number | null> {
  const row = await db.meta.get(key)
  return row?.value ?? null
}

export async function setMeta(key: string, value: string | number | null) {
  await db.meta.put({ key, value })
}

export async function getSettings(): Promise<Settings> {
  const existing = await db.settings.get('singleton')
  if (existing) return existing
  const fresh = { ...DEFAULT_SETTINGS, updatedAt: Date.now() }
  await db.settings.put(fresh)
  return fresh
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  const current = await getSettings()
  await db.settings.put({ ...current, ...patch, updatedAt: Date.now() })
}

/** Deterministic composite key, so the same row can't be inserted twice. */
export const compositeId = (conceptId: string, lang: string) =>
  `${conceptId}:${lang}`

export function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Normalised key for duplicate detection. Case- and diacritic-insensitive so
 * "Hund", "hund" and a stray accent all collapse to one concept — this is what
 * stops you paying the API twice for the same word.
 */
export function lemmaKey(lemma: string, lang: string): string {
  const base = lemma
    .trim()
    .toLocaleLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
  return `${lang}:${base}`
}
