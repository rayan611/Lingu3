import { z } from 'zod'

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------

/**
 * ADDING A LANGUAGE
 *
 * Add one entry to LANGUAGES below and you are done. Nothing is hard-coded to
 * three languages: the schema is per (word x language), the queue reads
 * whatever is active, and a language with no morphology rules of its own falls
 * back to plain entries rather than breaking.
 *
 * Two optional extras, worth doing for a language you will actually study:
 *   - morphology rules in MorphologySchema below (gender, verb forms)
 *   - display labels in src/lib/morphology.ts, so forms are labelled in that
 *     language's own grammatical terms
 *   - the matching block in MORPHOLOGY_RULES in api/expand.ts, so the model
 *     knows which fields to fill
 *
 * Without those three, the language still works — you just get the headword,
 * meaning and example rather than tables of forms.
 */
export const LANGUAGES = {
  fa: { name: 'Persian', native: 'فارسی', bcp47: 'fa-IR', rtl: true },
  en: { name: 'English', native: 'English', bcp47: 'en-GB', rtl: false },
  sv: { name: 'Swedish', native: 'Svenska', bcp47: 'sv-SE', rtl: false },
  de: { name: 'German', native: 'Deutsch', bcp47: 'de-DE', rtl: false },
  es: { name: 'Spanish', native: 'Español', bcp47: 'es-ES', rtl: false },
  ru: { name: 'Russian', native: 'Русский', bcp47: 'ru-RU', rtl: false },
} as const satisfies Record<
  string,
  { name: string; native: string; bcp47: string; rtl: boolean }
>

export type Lang = keyof typeof LANGUAGES

export const LANGS = Object.keys(LANGUAGES) as Lang[]

// Derived, so a new language cannot be half-added — one entry above and every
// lookup below has it.
export const LANG_NAMES = Object.fromEntries(
  Object.entries(LANGUAGES).map(([k, v]) => [k, v.name]),
) as Record<Lang, string>

export const LANG_NATIVE_NAMES = Object.fromEntries(
  Object.entries(LANGUAGES).map(([k, v]) => [k, v.native]),
) as Record<Lang, string>

/** BCP-47 tags, used for speech synthesis and `lang` attributes. */
export const LANG_BCP47 = Object.fromEntries(
  Object.entries(LANGUAGES).map(([k, v]) => [k, v.bcp47]),
) as Record<Lang, string>

export const RTL_LANGS: ReadonlySet<Lang> = new Set(
  (Object.entries(LANGUAGES) as [Lang, { rtl: boolean }][])
    .filter(([, v]) => v.rtl)
    .map(([k]) => k),
)

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

/**
 * Spanish. Structurally the closest to what German already needed: a gender
 * that decides the article, and a verb whose useful forms are the infinitive,
 * one present, one past and the participle.
 */
const esNoun = z.object({
  kind: z.literal('noun'),
  gender: z.enum(['el', 'la']),
  plural: z.string().optional(),
})

const esVerb = z.object({
  kind: z.literal('verb'),
  infinitivo: z.string(),
  /** 3rd person singular, where the stem changes surface: puede, duerme. */
  presente: z.string(),
  preterito: z.string(),
  participio: z.string(),
  gerundio: z.string().optional(),
  /** Reflexive verbs carry the pronoun: "levantarse", not "levantar". */
  reflexivo: z.boolean().optional(),
})

/**
 * Russian.
 *
 * Two things make this harder than the others. Nouns decline through six
 * cases, so the forms are a table rather than a couple of fields — the five
 * oblique singulars plus the nominative plural are stored, which is what a
 * textbook drills first.
 *
 * And verbs come in aspect pairs: писать and написать are one meaning in two
 * aspects, and a learner has to produce both. They are kept as ONE entry with
 * an `aspectPartner` field rather than two concepts, because splitting them
 * would mean two review histories and two entries in the known-word count for
 * what is, to the learner, one item. The partner is shown on the card.
 */
const ruNoun = z.object({
  kind: z.literal('noun'),
  gender: z.enum(['м', 'ж', 'с']),
  genitive: z.string().optional(),
  dative: z.string().optional(),
  accusative: z.string().optional(),
  instrumental: z.string().optional(),
  prepositional: z.string().optional(),
  nominativePlural: z.string().optional(),
  /** Animate nouns take the genitive in the accusative; worth flagging. */
  animate: z.boolean().optional(),
})

const ruVerb = z.object({
  kind: z.literal('verb'),
  infinitive: z.string(),
  aspect: z.enum(['несовершенный', 'совершенный']),
  /** The other half of the pair — the form you also have to be able to produce. */
  aspectPartner: z.string().optional(),
  /** 1st and 3rd singular, which is where the conjugation class shows. */
  presentFirst: z.string().optional(),
  presentThird: z.string().optional(),
  past: z.string().optional(),
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
export type EsNoun = z.infer<typeof esNoun>
export type EsVerb = z.infer<typeof esVerb>
export type RuNoun = z.infer<typeof ruNoun>
export type RuVerb = z.infer<typeof ruVerb>

export const MorphologySchema = z.discriminatedUnion('lang', [
  z.object({ lang: z.literal('sv'), form: z.union([svNoun, svVerb, simple]) }),
  z.object({ lang: z.literal('de'), form: z.union([deNoun, deVerb, simple]) }),
  z.object({ lang: z.literal('en'), form: z.union([enNoun, enVerb, simple]) }),
  z.object({ lang: z.literal('es'), form: z.union([esNoun, esVerb, simple]) }),
  z.object({ lang: z.literal('ru'), form: z.union([ruNoun, ruVerb, simple]) }),
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
  /** @deprecated single-category field; kept so pre-tags words keep working. */
  category: Category
  /**
   * Topics, free text and multi-valued. A word is routinely more than one
   * thing — `beställa` is restaurant and work — so a single category could not
   * survive contact with real use. `category` above is the old single field;
   * both are honoured when filtering.
   */
  tags?: string[]
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

/**
 * A text generated from words you already know.
 *
 * `knownCount` and `wordCount` are stored rather than recomputed on read: they
 * are a fact about the moment the text was written, and the vocabulary moves
 * underneath. A text that was 90% familiar in October should still say 90% in
 * December, not quietly improve.
 */
export interface Story {
  id: string
  title: string
  body: string
  lang: Lang
  genre: string
  topics: string[]
  wordCount: number
  knownCount: number
  unknownWords: string[]
  glossary?: { word: string; meaning: string }[]
  createdAt: number
  updatedAt: number
  deletedAt?: number
}

export const STORY_GENRES = [
  { id: 'fun', label: 'Everyday, light' },
  { id: 'fact', label: 'A true fact' },
  { id: 'social', label: 'A social situation' },
  { id: 'dialogue', label: 'A short dialogue' },
  { id: 'joke', label: 'A joke' },
] as const

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
  /**
   * What to call you in the app. Account data, so it syncs — unlike the theme,
   * which is a property of the device you happen to be holding.
   */
  displayName?: string
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
  /**
   * Type the answer for this language before revealing, instead of only
   * recalling it in your head. Deliberately one language: interference between
   * Swedish and German shows up in production, and typing all three would turn
   * a two-minute session into a ten-minute one.
   *
   * Device-local on purpose — it is a study habit, not account data, and it is
   * not worth a schema change on the server to carry it between devices.
   */
  typedLang?: Lang
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
  lang: z.enum(LANGS as [Lang, ...Lang[]]),
  headword: z.string().min(1),
  meaning: z.string().min(1),
  morphology: z.unknown().optional(),
  example: z.string().optional(),
  exampleGloss: z.string().optional(),
  notes: z.string().optional(),
})

/**
 * A word worth knowing alongside this one — usually not a synonym but a
 * register variant. `hallo` and `tjena` mean the same thing; which one you
 * say to your manager is the part that is hard to get from a dictionary.
 */
export const RelatedWordSchema = z.object({
  lang: z.enum(LANGS as [Lang, ...Lang[]]),
  word: z.string().min(1).max(60),
  meaning: z.string().max(80).optional(),
  /** "casual", "formal", "written only", "northern Sweden" — one or two words. */
  register: z.string().max(40).optional(),
  note: z.string().max(140).optional(),
})
export type RelatedWord = z.infer<typeof RelatedWordSchema>

export const ExpansionSchema = z.object({
  pos: z.enum(PARTS_OF_SPEECH),
  /** Suggested topics. Advisory — the user can change them before saving. */
  tags: z.array(z.string().min(1).max(24)).max(4).optional(),
  /** The model may correct a typo or strip an article; we show this to the user. */
  normalisedLemma: z.string().optional(),
  entries: z.array(ExpansionEntrySchema).min(1),
  related: z.array(RelatedWordSchema).max(6).optional(),
})
export type Expansion = z.infer<typeof ExpansionSchema>

/** One previewed entry, with its morphology already validated for display. */
export type WordPreviewEntryView = z.infer<typeof ExpansionEntrySchema> & {
  form: Morphology['form'] | undefined
}

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
