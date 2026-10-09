import type {
  DeNoun,
  DeVerb,
  EnNoun,
  EnVerb,
  Entry,
  EsNoun,
  EsVerb,
  Lang,
  Morphology,
  RuNoun,
  RuVerb,
  SvNoun,
  SvVerb,
} from '../db/types'

export interface MorphLine {
  label: string
  value: string
}

type Form = Morphology['form']

/**
 * Turns a morphology blob into labelled lines, using each language's own
 * grammatical terms. Showing a Swedish learner "preteritum" and a German
 * learner "Präteritum" is not pedantry — those are the words their textbook
 * and their teacher use.
 *
 * The casts below are safe because the stored form was validated against its
 * own language's schema on the way in (see `parseMorphology`). TypeScript
 * can't see that, because `kind` alone doesn't distinguish a Swedish noun
 * from a German one.
 */
export function morphLines(lang: Lang, form: Form | undefined): MorphLine[] {
  if (!form || form.kind === 'simple') return []

  if (lang === 'sv') {
    if (form.kind === 'noun') {
      const f = form as SvNoun
      return compact([
        f.definiteSingular && { label: 'bestämd', value: f.definiteSingular },
        f.indefinitePlural && { label: 'plural', value: f.indefinitePlural },
        f.definitePlural && { label: 'plural best.', value: f.definitePlural },
      ])
    }
    const f = form as SvVerb
    return compact([
      { label: 'infinitiv', value: f.infinitiv },
      { label: 'presens', value: f.presens },
      { label: 'preteritum', value: f.preteritum },
      { label: 'supinum', value: f.supinum },
      f.imperativ ? { label: 'imperativ', value: f.imperativ } : undefined,
    ])
  }

  if (lang === 'de') {
    if (form.kind === 'noun') {
      const f = form as DeNoun
      return compact([
        f.plural && { label: 'Plural', value: f.plural },
        f.genitiveSingular && { label: 'Genitiv', value: f.genitiveSingular },
      ])
    }
    const f = form as DeVerb
    return compact([
      { label: 'Infinitiv', value: f.infinitiv },
      { label: 'Präsens', value: f.praesens },
      { label: 'Präteritum', value: f.praeteritum },
      // The auxiliary is shown joined to the participle because that is the
      // unit you actually have to produce: "ist gegangen", not "sein".
      { label: 'Perfekt', value: `${f.auxiliary} ${f.partizip2}` },
      f.separable ? { label: 'trennbar', value: f.prefix ?? 'ja' } : undefined,
    ])
  }

  if (lang === 'es') {
    if (form.kind === 'noun') {
      const f = form as EsNoun
      return compact([f.plural && { label: 'plural', value: f.plural }])
    }
    const f = form as EsVerb
    return compact([
      { label: 'infinitivo', value: f.infinitivo },
      { label: 'presente', value: f.presente },
      { label: 'pretérito', value: f.preterito },
      { label: 'participio', value: f.participio },
      f.gerundio ? { label: 'gerundio', value: f.gerundio } : undefined,
      f.reflexivo ? { label: 'reflexivo', value: 'sí' } : undefined,
    ])
  }

  if (lang === 'ru') {
    if (form.kind === 'noun') {
      const f = form as RuNoun
      return compact([
        f.genitive && { label: 'родительный', value: f.genitive },
        f.dative && { label: 'дательный', value: f.dative },
        f.accusative && { label: 'винительный', value: f.accusative },
        f.instrumental && { label: 'творительный', value: f.instrumental },
        f.prepositional && { label: 'предложный', value: f.prepositional },
        f.nominativePlural && { label: 'мн. число', value: f.nominativePlural },
      ])
    }
    const f = form as RuVerb
    return compact([
      { label: 'вид', value: f.aspect },
      // The other half of the pair, which you also have to be able to produce.
      // Kept on the same entry rather than split into a second word: to a
      // learner this is one item with two forms, and splitting it would mean
      // two review histories for one memory.
      f.aspectPartner ? { label: 'видовая пара', value: f.aspectPartner } : undefined,
      f.presentFirst ? { label: 'я', value: f.presentFirst } : undefined,
      f.presentThird ? { label: 'он/она', value: f.presentThird } : undefined,
      f.past ? { label: 'прошедшее', value: f.past } : undefined,
    ])
  }

  if (lang === 'en') {
    if (form.kind === 'noun') {
      const f = form as EnNoun
      return compact([f.plural && { label: 'plural', value: f.plural }])
    }
    const f = form as EnVerb
    return compact([
      { label: 'past', value: f.past },
      { label: 'participle', value: f.pastParticiple },
    ])
  }

  return []
}

/**
 * The gender marker, shown as its own badge rather than buried in the forms.
 * For Swedish and German it is the single highest-value field on the card, and
 * it only sticks if it is learned together with the word rather than bolted on
 * afterwards.
 */
export function genderBadge(lang: Lang, form: Form | undefined): string | null {
  if (!form || form.kind !== 'noun') return null
  if (lang === 'sv') return (form as SvNoun).gender
  if (lang === 'de') return (form as DeNoun).gender
  if (lang === 'es') return (form as EsNoun).gender
  if (lang === 'ru') return (form as RuNoun).gender
  return null
}

/** True when an entry is missing the forms a learner of that language needs. */
export function isIncomplete(entry: Entry): boolean {
  if (!entry.morphology) return true
  if (entry.morphology.kind !== 'noun') return false
  // The languages where a missing gender is expensive: it decides the article
  // or the whole declension, and the scheduler will drill a wrong one for
  // months.
  if (!['sv', 'de', 'es', 'ru'].includes(entry.lang)) return false
  return !genderBadge(entry.lang, entry.morphology)
}

function compact(items: (MorphLine | false | undefined | '')[]): MorphLine[] {
  return items.filter((x): x is MorphLine => !!x)
}
