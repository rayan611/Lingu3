import type {
  DeNoun,
  DeVerb,
  EnNoun,
  EnVerb,
  Entry,
  Lang,
  Morphology,
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
  return null
}

/** True when an entry is missing the forms a learner of that language needs. */
export function isIncomplete(entry: Entry): boolean {
  if (!entry.morphology) return true
  if (entry.morphology.kind !== 'noun') return false
  if (entry.lang !== 'sv' && entry.lang !== 'de') return false
  return !genderBadge(entry.lang, entry.morphology)
}

function compact(items: (MorphLine | false | undefined | '')[]): MorphLine[] {
  return items.filter((x): x is MorphLine => !!x)
}
