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

/**
 * Local-first store. The app only ever reads and writes here; anything remote
 * is a background push/pull on top (not in v1). Every mutable row carries
 * `updatedAt` so last-write-wins sync can be bolted on without a migration.
 */
export class LinguaDB extends Dexie {
  concepts!: Table<Concept, string>
  entries!: Table<Entry, string>
  cards!: Table<Card, string>
  reviewLog!: Table<ReviewLogRow, string>
  pending!: Table<PendingExpansion, string>
  settings!: Table<Settings, string>

  constructor() {
    super('lingua')
    this.version(1).stores({
      concepts: 'id, lemma, sourceLang, pos, category, updatedAt, deletedAt',
      entries: 'id, conceptId, lang, headword, updatedAt, [conceptId+lang]',
      // `[lang+due]` is the index the review queue runs on.
      cards: 'id, conceptId, lang, due, state, updatedAt, [lang+due]',
      reviewLog: 'id, cardId, conceptId, lang, reviewedAt',
      pending: 'id, conceptId, createdAt',
      settings: 'id',
    })
  }
}

export const db = new LinguaDB()

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
