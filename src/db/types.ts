import { z } from 'zod'

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------

export const LANGS = ['fa', 'en', 'sv', 'de'] as const
export type Lang = (typeof LANGS)[number]

export const LANG_NAMES: Record<Lang, string> = {
  fa: 'Persian',
  en: 'English',
  sv: 'Swedish',
  de: 'German',
}

export const LANG_NATIVE_NAMES: Record<Lang, string> = {
  fa: 'فارسی',
  en: 'English',
  sv: 'Svenska',
  de: 'Deutsch',
}

/** BCP-47 tags, used for speech synthesis and `lang` attributes. */
export const LANG_BCP47: Record<Lang, string> = {
  fa: 'fa-IR',
  en: 'en-GB',
  sv: 'sv-SE',
  de: 'de-DE',
}

export const RTL_LANGS: ReadonlySet<Lang> = new Set<Lang>(['fa'])

// ---------------------------------------------------------------------------
// Parts of speech and categories
// ---------------------------------------------------------------------------

export const PARTS_OF_SPEECH = [
  'noun',
  'verb',
  'adjective',
  'adverb',
  'preposition',
  'phrase',
  'other',
] as const
export type PartOfSpeech = (typeof PARTS_OF_SPEECH)[number]

export const CATEGORIES = [
  'daily',
  'verbs',
  'prepositions',
  'work',
  'travel',
  'food',
  'home',
  'uncategorised',
] as const
export type Category = (typeof CATEGORIES)[number]

// ---------------------------------------------------------------------------
// Morphology — deliberately per-language.
//
// A shared schema across Swedish, German and English silently loses
// information: German needs an auxiliary verb and a separable-prefix flag that
// Swedish has no use for, and the two languages' noun genders are different
// systems entirely. So this is a discriminated union on `lang`.
// ---------------------------------------------------------------------------

const svNoun = z.object({
  kind: z.literal('noun'),
  /** Swedish common/neuter gender — decides the indefinite article. */
  gender: z.enum(['en', 'ett']),
  definiteSingular: z.string().optional(),
  indefinitePlural: z.string().optional(),
  definitePlural: z.string().optional(),
})

const svVerb = z.object({
  kind: z.literal('verb'),
  infinitiv: z.string(),
  presens: z.string(),
  preteritum: z.string(),
  supinum: z.string(),
  imperativ: z.string().optional(),
  /** e.g. "gå upp" — particle verbs behave like German separables. */
  particle: z.string().optional(),
})

const deNoun = z.object({
  kind: z.literal('noun'),
  gender: z.enum(['der', 'die', 'das']),
  plural: z.string().optional(),
  /** Genitive singular — needed for the strong/weak declension patterns. */
  genitiveSingular: z.string().optional(),
})

const deVerb = z.object({
  kind: z.literal('verb'),
  infinitiv: z.string(),
  /** 3rd person singular, which is where stem changes surface. */
  praesens: z.string(),
  praeteritum: z.string(),
  partizip2: z.string(),
  /** Perfect tense auxiliary. Getting this wrong is the classic learner error. */
  auxiliary: z.enum(['haben', 'sein']),
  separable: z.boolean(),
  /** The detached prefix, if separable: "aufstehen" -> "auf". */
  prefix: z.string().optional(),
})

const enNoun = z.object({
  kind: z.literal('noun'),
  plural: z.string().optional(),
})

const enVerb = z.object({
  kind: z.literal('verb'),
  base: z.string(),
  thirdPerson: z.string(),
  past: z.string(),
  pastParticiple: z.string(),
})

const faSimple = z.object({ kind: z.literal('simple') })
const simple = z.object({ kind: z.literal('simple') })

// Exported so display code can narrow to one language's form. `kind` alone is
// not enough to narrow across the whole union: a "noun" could be Swedish or
// German, and those have different fields.
export type SvNoun = z.infer<typeof svNoun>
export type SvVerb = z.infer<typeof svVerb>
export type DeNoun = z.infer<typeof deNoun>
export type DeVerb = z.infer<typeof deVerb>
export type EnNoun = z.infer<typeof enNoun>
export type EnVerb = z.infer<typeof enVerb>

export const MorphologySchema = z.discriminatedUnion('lang', [
  z.object({ lang: z.literal('sv'), form: z.union([svNoun, svVerb, simple]) }),
  z.object({ lang: z.literal('de'), form: z.union([deNoun, deVerb, simple]) }),
  z.object({ lang: z.literal('en'), form: z.union([enNoun, enVerb, simple]) }),
  z.object({ lang: z.literal('fa'), form: faSimple }),
])
export type Morphology = z.infer<typeof MorphologySchema>

// ---------------------------------------------------------------------------
// Core records
// ---------------------------------------------------------------------------

/**
 * A concept is the language-independent anchor: one idea, N language entries.
 * Everything else hangs off this, which is what makes "turn German off" and
 * "add a fourth language later" cheap instead of a migration.
 */
export interface Concept {
  id: string
  /** The word as the user typed it. */
  lemma: string
  /** Which language they typed it in. */
  sourceLang: Lang
  pos: PartOfSpeech
  category: Category
  notes?: string
  createdAt: number
  updatedAt: number
  /** Soft delete — a hard delete can't be replicated to other devices. */
  deletedAt?: number
}

export interface Entry {
  /** `${conceptId}:${lang}` — deterministic, so sync can't duplicate it. */
  id: string
  conceptId: string
  lang: Lang
  /** The word in this language, including its article where that's idiomatic. */
  headword: string
  /** A short gloss. */
  meaning: string
  morphology?: Morphology['form']
  /** One example sentence. Parallel across languages — same situation, not a
   *  literal translation, so the sentences can be compared side by side. */
  example?: string
  exampleGloss?: string
  notes?: string
  updatedAt: number
}

export const CARD_STATES = ['New', 'Learning', 'Review', 'Relearning'] as const

/**
 * One FSRS card per (concept x language). This is the decision that lets a
 * language be switched off and back on without losing or corrupting its
 * schedule, and stops an easy English item from being dragged around by a
 * hard German one at the algorithm level.
 */
export interface Card {
  /** `${conceptId}:${lang}` */
  id: string
  conceptId: string
  lang: Lang
  // --- FSRS state, stored flat so Dexie can index `due` ---
  due: number
  stability: number
  difficulty: number
  elapsedDays: number
  scheduledDays: number
  learningSteps: number
  reps: number
  lapses: number
  state: number
  lastReview?: number
  /** Suspended cards never enter the queue but keep their state intact. */
  suspended?: boolean
  updatedAt: number
}

/** Append-only. This is the one table that can never conflict on sync. */
export interface ReviewLogRow {
  id: string
  cardId: string
  conceptId: string
  lang: Lang
  grade: number
  state: number
  due: number
  stability: number
  difficulty: number
  elapsedDays: number
  lastElapsedDays: number
  scheduledDays: number
  reviewedAt: number
}

/** A word added while offline, waiting for expansion. */
export interface PendingExpansion {
  id: string
  conceptId: string
  attempts: number
  lastError?: string
  createdAt: number
}

export interface Settings {
  id: 'singleton'
  nativeLang: Lang
  /** Ordered by priority — this is the stacking order on the review card. */
  targetLangs: Lang[]
  /** Subset of targetLangs that are currently being studied. Anything not in
   *  here keeps its cards but is excluded from scheduling and the queue. */
  activeLangs: Lang[]
  dailyNewLimit: number
  dailyReviewLimit: number
  /** FSRS target recall probability. 0.9 is the usual default. */
  requestRetention: number
  updatedAt: number
}

export const DEFAULT_SETTINGS: Settings = {
  id: 'singleton',
  nativeLang: 'fa',
  targetLangs: ['sv', 'de', 'en'],
  activeLangs: ['sv', 'de', 'en'],
  dailyNewLimit: 15,
  dailyReviewLimit: 150,
  requestRetention: 0.9,
  updatedAt: 0,
}

// ---------------------------------------------------------------------------
// AI expansion payload
//
// The model is asked for exactly this shape. Anything that doesn't parse is
// rejected rather than written, so a bad response can't corrupt the database.
// ---------------------------------------------------------------------------

export const ExpansionEntrySchema = z.object({
  lang: z.enum(LANGS),
  headword: z.string().min(1),
  meaning: z.string().min(1),
  morphology: z.unknown().optional(),
  example: z.string().optional(),
  exampleGloss: z.string().optional(),
  notes: z.string().optional(),
})

export const ExpansionSchema = z.object({
  pos: z.enum(PARTS_OF_SPEECH),
  /** The model may correct a typo or strip an article; we show this to the user. */
  normalisedLemma: z.string().optional(),
  entries: z.array(ExpansionEntrySchema).min(1),
})
export type Expansion = z.infer<typeof ExpansionSchema>

/**
 * Validates the morphology blob against the schema for its own language.
 * Returns undefined rather than throwing: a wrong gender field should cost us
 * the gender, not the whole word.
 */
export function parseMorphology(
  lang: Lang,
  raw: unknown,
): Morphology['form'] | undefined {
  if (raw == null || typeof raw !== 'object') return undefined
  const result = MorphologySchema.safeParse({ lang, form: raw })
  return result.success ? result.data.form : undefined
}
