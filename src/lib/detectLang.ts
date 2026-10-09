import { LANGS, type Lang } from '../db/types'

/**
 * Guesses which language a typed word is in.
 *
 * Offline, instant, and free — no model call. It runs on every keystroke in
 * the Add box, so it has to be all three.
 *
 * Deliberately a *suggestion*: it fills the dropdown's hint, never the
 * dropdown itself. A silent wrong guess that files a German noun as Swedish
 * is far worse than no guess at all, because you only find out weeks later
 * when the genders are nonsense.
 *
 * Two stages. Script is decisive where it applies: Cyrillic is Russian and
 * Persian script is Persian, with nothing to weigh up. Latin needs evidence,
 * so each language scores on marks and letter sequences that are common in it
 * and rare or impossible in the others, and a guess is only returned when one
 * language is clearly ahead.
 */

export interface LangGuess {
  lang: Lang
  /** 'certain' for a decisive script; 'likely' for a Latin-script winner. */
  confidence: 'certain' | 'likely'
}

/** Marks that only appear in one of the Latin-script languages here. */
const EXCLUSIVE: Partial<Record<Lang, RegExp>> = {
  // å is Swedish; ä and ö are shared with German, so they are not here.
  sv: /[åÅ]/,
  de: /[ßüÜ]/,
  es: /[ñÑ¿¡áíóú]/,
}

/**
 * Sequences that are characteristic rather than exclusive. Each hit is worth
 * less than a mark above, and they only decide a word that carries no marks
 * at all.
 */
const PATTERNS: Partial<Record<Lang, RegExp[]>> = {
  sv: [/sk[jö]/i, /stj/i, /tj/i, /ng$/i, /\b(en|ett) /i, /[äö]/],
  de: [/sch/i, /^ge[a-z]{2,}t$/i, /ung$/i, /keit$/i, /heit$/i, /tsch/i, /^[A-ZÄÖÜ][a-zäöüß]{3,}$/],
  es: [/ción$/i, /^(el|la|los|las) /i, /ll/i, /rr/i, /dad$/i],
  en: [/^(the|a|an) /i, /tion$/i, /ough/i, /ight$/i, /ing$/i],
}

/** Latin-script languages, in the order ties are broken — most marked first. */
const LATIN: Lang[] = ['sv', 'de', 'es', 'en']

export function detectLang(input: string): LangGuess | null {
  const text = input.trim()
  if (text.length < 2) return null

  // --- stage one: script, where it settles the question outright ----------
  if (/[Ѐ-ӿ]/.test(text) && LANGS.includes('ru')) {
    return { lang: 'ru', confidence: 'certain' }
  }
  // Arabic block, which Persian is written in. Note this says "Persian script",
  // not "Persian": were Arabic ever added as a target, this would need the
  // Persian-only letters (گ چ پ ژ) to tell them apart.
  if (/[؀-ۿ]/.test(text) && LANGS.includes('fa')) {
    return { lang: 'fa', confidence: 'certain' }
  }
  if (!/[a-zA-ZÀ-ÿ]/.test(text)) return null

  // --- stage two: weigh the Latin-script candidates -----------------------
  const score = new Map<Lang, number>()
  for (const lang of LATIN) {
    if (!LANGS.includes(lang)) continue
    let n = 0
    const exclusive = EXCLUSIVE[lang]
    if (exclusive?.test(text)) n += 3
    for (const re of PATTERNS[lang] ?? []) if (re.test(text)) n += 1
    if (n > 0) score.set(lang, n)
  }
  if (score.size === 0) return null

  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1])
  const [best, bestScore] = ranked[0]!
  const runnerUp = ranked[1]?.[1] ?? 0
  // A win by a single weak pattern is a coin toss dressed up as an answer.
  if (bestScore <= runnerUp) return null
  return { lang: best, confidence: 'likely' }
}
