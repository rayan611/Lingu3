import { db, newId } from '../db/db'
import { authConfigured, supabase } from '../auth/supabase'
import { matchesTopic } from '../fsrs/queue'
import { morphLines } from '../lib/morphology'
import type { Lang, Settings, Story } from '../db/types'

/**
 * Reading texts built from the words you already know.
 *
 * This is the one place the "AI at write time, never at review time" rule is
 * deliberately broken — and it still holds where it matters, which is that
 * grading a card never needs a network. Generating a text is something you
 * ask for, in its own screen, knowing it will take a few seconds.
 */

export interface StoryRequest {
  lang: Lang
  topics: string[]
  genre: string
  length: 'short' | 'long'
  /** Share of new content words the model may introduce. The difficulty dial. */
  unknownShare: number
}

export interface GeneratedStory {
  title: string
  body: string
  glossary: { word: string; meaning: string }[]
}

/** Words are compared case-insensitively; diacritics are kept, since they are
 *  part of the spelling being learned. */
export function normaliseToken(token: string): string {
  return token.trim().toLocaleLowerCase().replace(/[’']/g, "'")
}

/** Splits text into words, across Latin and Cyrillic alike. */
export function tokenise(text: string): string[] {
  return text.match(/[\p{L}\p{M}][\p{L}\p{M}'’-]*/gu) ?? []
}

const ARTICLES: Partial<Record<Lang, string[]>> = {
  sv: ['en', 'ett'],
  de: ['der', 'die', 'das'],
  en: ['a', 'an', 'the'],
  es: ['el', 'la', 'los', 'las'],
}

function stripArticle(word: string, lang: Lang): string {
  const parts = word.trim().split(/\s+/)
  if (parts.length < 2) return word.trim()
  if ((ARTICLES[lang] ?? []).includes(parts[0].toLocaleLowerCase())) {
    return parts.slice(1).join(' ')
  }
  return word.trim()
}

export interface Vocabulary {
  /** Dictionary forms, to send to the model. */
  headwords: string[]
  /** Every form that should count as known when checking coverage. */
  known: Set<string>
}

/**
 * The vocabulary for one language.
 *
 * Inflected forms count as known. The morphology tables already hold them —
 * hundar, hundarna, skrev, geschrieben — and without them a text would score
 * as full of unknown words purely because it was written in real sentences
 * rather than in dictionary entries.
 */
export async function collectVocabulary(
  lang: Lang,
  topics: string[],
): Promise<Vocabulary> {
  const entries = await db.entries.where('lang').equals(lang).toArray()
  const conceptIds = [...new Set(entries.map((e) => e.conceptId))]
  const concepts = await db.concepts.bulkGet(conceptIds)
  const byId = new Map(concepts.filter(Boolean).map((c) => [c!.id, c!]))

  const headwords: string[] = []
  const known = new Set<string>()

  for (const entry of entries) {
    const concept = byId.get(entry.conceptId)
    if (!concept || concept.deletedAt) continue
    if (
      topics.length > 0 &&
      !topics.some((t) => matchesTopic(concept, t))
    ) {
      continue
    }

    const bare = stripArticle(entry.headword, lang)
    headwords.push(bare)
    for (const token of tokenise(bare)) known.add(normaliseToken(token))

    for (const line of morphLines(lang, entry.morphology)) {
      for (const token of tokenise(line.value)) known.add(normaliseToken(token))
    }
  }

  return { headwords, known }
}

export interface Coverage {
  total: number
  known: number
  unknown: string[]
  ratio: number
}

/**
 * How much of a text is actually made of words you have studied.
 *
 * This is computed here, against the real vocabulary, and not taken from the
 * model. Models drift off a constrained word list constantly — asking one to
 * report its own compliance is asking the wrong party. The number shown to the
 * reader is this one.
 *
 * Nation's work on reading comprehension puts the threshold around 95% known
 * words with support and about 98% without; below that a text stops being
 * input and becomes decoding. That is what the number is for.
 */
export function measureCoverage(body: string, known: Set<string>): Coverage {
  const tokens = tokenise(body)
  const unknown: string[] = []
  let hits = 0
  for (const token of tokens) {
    const word = normaliseToken(token)
    if (known.has(word)) hits++
    else if (!unknown.includes(word)) unknown.push(word)
  }
  return {
    total: tokens.length,
    known: hits,
    unknown,
    ratio: tokens.length ? hits / tokens.length : 0,
  }
}

export class StoryError extends Error {}

async function authHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (authConfigured) {
    const { data } = await supabase().auth.getSession()
    const token = data.session?.access_token
    if (token) headers.authorization = `Bearer ${token}`
  }
  return headers
}

export async function generateStory(
  req: StoryRequest,
  settings: Settings,
): Promise<{ story: GeneratedStory; coverage: Coverage; vocabulary: Vocabulary }> {
  const vocabulary = await collectVocabulary(req.lang, req.topics)
  if (vocabulary.headwords.length < 5) {
    throw new StoryError(
      'Not enough words in that language yet — add a few more, or widen the topics.',
    )
  }

  let res: Response
  try {
    res = await fetch('/api/story', {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({
        lang: req.lang,
        nativeLang: settings.nativeLang,
        // Newest first: the words you just added are the ones worth seeing in
        // a sentence, and the prompt is capped server-side anyway.
        words: vocabulary.headwords.slice().reverse(),
        genre: req.genre,
        length: req.length,
        unknownShare: req.unknownShare,
      }),
    })
  } catch {
    throw new StoryError('You are offline — a text needs the network.')
  }

  if (!res.ok) {
    let detail = ''
    try {
      const body = (await res.json()) as { error?: string; detail?: string }
      detail = [body.error, body.detail].filter(Boolean).join(' — ')
    } catch {
      /* not JSON; the status will have to do */
    }
    throw new StoryError(detail || `Request failed (${res.status}).`)
  }

  const raw = (await res.json()) as Partial<GeneratedStory>
  if (!raw.body || typeof raw.body !== 'string') {
    throw new StoryError('The model returned nothing readable.')
  }

  const story: GeneratedStory = {
    title: (raw.title ?? '').trim() || 'Untitled',
    body: raw.body.trim(),
    glossary: Array.isArray(raw.glossary)
      ? raw.glossary.filter((g) => g && g.word && g.meaning)
      : [],
  }

  return { story, coverage: measureCoverage(story.body, vocabulary.known), vocabulary }
}

export async function saveStory(opts: {
  story: GeneratedStory
  coverage: Coverage
  req: StoryRequest
}): Promise<string> {
  const now = Date.now()
  const row: Story = {
    id: newId(),
    title: opts.story.title,
    body: opts.story.body,
    lang: opts.req.lang,
    genre: opts.req.genre,
    topics: opts.req.topics,
    wordCount: opts.coverage.total,
    knownCount: opts.coverage.known,
    unknownWords: opts.coverage.unknown,
    glossary: opts.story.glossary,
    createdAt: now,
    updatedAt: now,
  }
  await db.stories.add(row)
  return row.id
}

export async function deleteStory(id: string): Promise<void> {
  const existing = await db.stories.get(id)
  if (!existing) return
  // Soft, like everything else here: a row missing locally always loses
  // last-write-wins, so a hard delete would be undone by the next full resync.
  await db.stories.put({ ...existing, deletedAt: Date.now(), updatedAt: Date.now() })
}

/**
 * What a word in a text means.
 *
 * The local vocabulary is checked first — instant, offline, and free — and the
 * glossary that came with the text second. Only a word in neither needs the
 * network, which is the difference between tapping words on a train and not.
 */
export async function lookupInText(
  word: string,
  lang: Lang,
  glossary: { word: string; meaning: string }[],
): Promise<{ meaning: string; source: 'yours' | 'glossary' } | null> {
  const target = normaliseToken(word)

  const entries = await db.entries.where('lang').equals(lang).toArray()
  for (const entry of entries) {
    const forms = new Set<string>()
    for (const token of tokenise(stripArticle(entry.headword, lang))) {
      forms.add(normaliseToken(token))
    }
    for (const line of morphLines(lang, entry.morphology)) {
      for (const token of tokenise(line.value)) forms.add(normaliseToken(token))
    }
    if (forms.has(target)) {
      const concept = await db.concepts.get(entry.conceptId)
      if (concept && !concept.deletedAt) {
        return { meaning: `${entry.headword} — ${entry.meaning}`, source: 'yours' }
      }
    }
  }

  const hit = glossary.find((g) => normaliseToken(g.word) === target)
  return hit ? { meaning: hit.meaning, source: 'glossary' } : null
}
