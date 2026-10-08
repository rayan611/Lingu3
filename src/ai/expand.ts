import { db, compositeId, lemmaKey, newId } from '../db/db'
import { authConfigured, supabase } from '../auth/supabase'
import { makeCard } from '../fsrs/scheduler'
import {
  ExpansionSchema,
  parseMorphology,
  type Category,
  type Concept,
  type Entry,
  type Expansion,
  type Lang,
  type PartOfSpeech,
  type Settings,
} from '../db/types'

export class ExpansionError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
  }
}

/** Calls the serverless endpoint and validates the result before it is trusted. */
export async function fetchExpansion(opts: {
  lemma: string
  sourceLang: Lang
  nativeLang: Lang
  langs: Lang[]
  hint?: string
}): Promise<Expansion> {
  // The endpoint is public, so it authenticates the caller. Sending the
  // session token is what makes this request ours rather than anyone's.
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (authConfigured) {
    const { data } = await supabase().auth.getSession()
    const token = data.session?.access_token
    if (token) headers.authorization = `Bearer ${token}`
  }

  let res: Response
  try {
    res = await fetch('/api/expand', {
      method: 'POST',
      headers,
      body: JSON.stringify(opts),
    })
  } catch {
    throw new ExpansionError('Offline — queued for later.', true)
  }

  if (!res.ok) {
    let detail = ''
    try {
      detail = ((await res.json()) as { error?: string }).error ?? ''
    } catch {
      /* body wasn't JSON; the status is enough */
    }
    // 4xx other than rate limiting means the request itself was wrong, so
    // retrying it unchanged would just fail again.
    // 401 is retryable here: the usual cause is a session token that expired
    // between opening the app and adding a word, and the next attempt carries
    // a refreshed one. Dropping the word from the queue for that would be
    // losing work over a five-minute clock.
    const retryable =
      res.status === 429 || res.status === 401 || res.status >= 500
    // A gateway timeout has no JSON body of ours to read, so say what it means
    // rather than showing a bare status number.
    const fallback =
      res.status === 504
        ? 'The expansion server timed out before the model answered.'
        : res.status === 429
          ? 'Rate limited. Wait a moment and press "Expand now".'
          : res.status === 401
            ? 'Your session expired. Reload the page and press "Expand now".'
            : `Request failed (${res.status}).`
    throw new ExpansionError(detail || fallback, retryable)
  }

  const parsed = ExpansionSchema.safeParse(await res.json())
  if (!parsed.success) {
    throw new ExpansionError('The model returned an unexpected shape.', true)
  }
  return parsed.data
}

/**
 * Writes an expansion into the database: one entry per language, one FSRS card
 * per active target language.
 *
 * Existing cards are never touched. Re-expanding a word to fix a bad meaning
 * must not reset the schedule you have built up on it.
 */
export async function applyExpansion(
  conceptId: string,
  expansion: Expansion,
  settings: Settings,
): Promise<void> {
  const now = Date.now()
  const wanted = new Set<Lang>([settings.nativeLang, ...settings.targetLangs])

  const entries: Entry[] = expansion.entries
    .filter((e) => wanted.has(e.lang))
    .map((e) => ({
      id: compositeId(conceptId, e.lang),
      conceptId,
      lang: e.lang,
      headword: e.headword,
      meaning: e.meaning,
      morphology: parseMorphology(e.lang, e.morphology),
      example: e.example,
      exampleGloss: e.exampleGloss,
      notes: e.notes,
      updatedAt: now,
    }))

  await db.transaction('rw', db.concepts, db.entries, db.cards, db.pending, async () => {
    await db.entries.bulkPut(entries)

    const concept = await db.concepts.get(conceptId)
    if (concept) {
      await db.concepts.put({
        ...concept,
        pos: expansion.pos as PartOfSpeech,
        lemma: expansion.normalisedLemma?.trim() || concept.lemma,
        updatedAt: now,
      })
    }

    // Create cards only for target languages that got an entry, and only where
    // one does not already exist.
    for (const lang of settings.targetLangs) {
      if (!entries.some((e) => e.lang === lang)) continue
      const id = compositeId(conceptId, lang)
      const existing = await db.cards.get(id)
      if (!existing) await db.cards.add(makeCard(conceptId, lang))
    }

    await db.pending.where('conceptId').equals(conceptId).delete()
  })
}

/**
 * Finds a word you already have, in two passes.
 *
 * The first is the obvious one: the same lemma typed in the same language.
 * The second catches the case that matters more — typing "dog" in English
 * when "hund" was already added in Swedish and expanded. They are one idea,
 * and the reading generator counts known words, so two concepts for one word
 * would quietly inflate the count and split its review history in half.
 */
async function findExisting(lemma: string, sourceLang: Lang) {
  const key = lemmaKey(lemma, sourceLang)

  const byLemma = await db.concepts
    .where('sourceLang')
    .equals(sourceLang)
    .filter((c) => !c.deletedAt && lemmaKey(c.lemma, c.sourceLang) === key)
    .first()
  if (byLemma) return byLemma

  // Compare against the headwords already generated in that language. The
  // article is stripped first, because entries store "en hund" / "der Hund"
  // while you would type "hund".
  const stripped = stripArticle(lemma, sourceLang)
  const match = await db.entries
    .where('lang')
    .equals(sourceLang)
    .filter(
      (e) =>
        lemmaKey(stripArticle(e.headword, e.lang), e.lang) ===
        lemmaKey(stripped, sourceLang),
    )
    .first()
  if (!match) return undefined

  const concept = await db.concepts.get(match.conceptId)
  return concept && !concept.deletedAt ? concept : undefined
}

const ARTICLES: Partial<Record<Lang, string[]>> = {
  sv: ['en', 'ett'],
  de: ['der', 'die', 'das'],
  en: ['a', 'an', 'the'],
}

function stripArticle(word: string, lang: Lang): string {
  const parts = word.trim().split(/\s+/)
  if (parts.length < 2) return word.trim()
  const first = parts[0].toLocaleLowerCase()
  if ((ARTICLES[lang] ?? []).includes(first)) return parts.slice(1).join(' ')
  return word.trim()
}

export interface AddWordResult {
  conceptId: string
  status: 'expanded' | 'queued' | 'duplicate'
  message?: string
}

/**
 * Adds a word. The concept row is written immediately so nothing is lost if the
 * expansion fails — the word is yours, the expansion is a nice-to-have that can
 * be retried. This is what makes adding words offline work at all.
 */
export async function addWord(opts: {
  lemma: string
  sourceLang: Lang
  category: Category
  hint?: string
  settings: Settings
}): Promise<AddWordResult> {
  const { settings } = opts
  const lemma = opts.lemma.trim()
  if (!lemma) throw new Error('Enter a word first.')

  // Dedupe before spending anything on the API.
  const existing = await findExisting(lemma, opts.sourceLang)
  if (existing) {
    return {
      conceptId: existing.id,
      status: 'duplicate',
      message: `"${existing.lemma}" is already in your list.`,
    }
  }

  const now = Date.now()
  const concept: Concept = {
    id: newId(),
    lemma,
    sourceLang: opts.sourceLang,
    pos: 'other',
    category: opts.category,
    notes: opts.hint,
    createdAt: now,
    updatedAt: now,
  }
  await db.concepts.add(concept)

  try {
    const expansion = await fetchExpansion({
      lemma,
      sourceLang: opts.sourceLang,
      nativeLang: settings.nativeLang,
      langs: [settings.nativeLang, ...settings.targetLangs],
      hint: opts.hint,
    })
    await applyExpansion(concept.id, expansion, settings)
    return { conceptId: concept.id, status: 'expanded' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await db.pending.put({
      id: newId(),
      conceptId: concept.id,
      attempts: 1,
      lastError: message,
      createdAt: now,
    })
    return { conceptId: concept.id, status: 'queued', message }
  }
}

/**
 * Drains the pending queue. Called on startup and whenever the browser comes
 * back online. Sequential on purpose — a burst of parallel calls after a day
 * offline is the fastest way to hit a rate limit.
 */
export async function processPending(
  settings: Settings,
  onProgress?: (done: number, total: number) => void,
): Promise<{ done: number; failed: number }> {
  if (!navigator.onLine) return { done: 0, failed: 0 }

  const queue = await db.pending.orderBy('createdAt').toArray()
  let done = 0
  let failed = 0

  for (const [i, item] of queue.entries()) {
    const concept = await db.concepts.get(item.conceptId)
    if (!concept || concept.deletedAt) {
      await db.pending.delete(item.id)
      continue
    }

    try {
      const expansion = await fetchExpansion({
        lemma: concept.lemma,
        sourceLang: concept.sourceLang,
        nativeLang: settings.nativeLang,
        langs: [settings.nativeLang, ...settings.targetLangs],
        hint: concept.notes,
      })
      await applyExpansion(concept.id, expansion, settings)
      done++
    } catch (err) {
      failed++
      const retryable = err instanceof ExpansionError ? err.retryable : true
      const attempts = item.attempts + 1
      // Give up after five tries so a permanently broken word doesn't block
      // the queue forever.
      if (!retryable || attempts > 5) {
        await db.pending.delete(item.id)
      } else {
        await db.pending.put({
          ...item,
          attempts,
          lastError: err instanceof Error ? err.message : String(err),
        })
      }
      if (!navigator.onLine) break
    }
    onProgress?.(i + 1, queue.length)
  }

  return { done, failed }
}

/** Re-runs expansion for a word that came out wrong, keeping its schedule. */
export async function reExpand(
  conceptId: string,
  settings: Settings,
): Promise<void> {
  const concept = await db.concepts.get(conceptId)
  if (!concept) throw new Error('Word not found.')
  const expansion = await fetchExpansion({
    lemma: concept.lemma,
    sourceLang: concept.sourceLang,
    nativeLang: settings.nativeLang,
    langs: [settings.nativeLang, ...settings.targetLangs],
    hint: concept.notes,
  })
  await applyExpansion(conceptId, expansion, settings)
}
