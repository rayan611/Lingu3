import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Grade } from 'ts-fsrs'
import { buildQueue, type QueueItem } from '../fsrs/queue'
import {
  GRADES,
  GRADE_HINTS,
  GRADE_LABELS,
  gradeCard,
  previewIntervals,
} from '../fsrs/scheduler'
import {
  LANG_BCP47,
  LANG_NAMES,
  RTL_LANGS,
  type Card,
  type Lang,
  type Settings,
} from '../db/types'
import { genderBadge, morphLines } from '../lib/morphology'

interface Props {
  settings: Settings
  onExit: () => void
}

export function Review({ settings, onExit }: Props) {
  const [queue, setQueue] = useState<QueueItem[] | null>(null)
  const [index, setIndex] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const [graded, setGraded] = useState<Record<string, Grade>>({})
  const [sessionCount, setSessionCount] = useState(0)
  const [typed, setTyped] = useState('')
  const [typedVerdict, setTypedVerdict] = useState<'right' | 'wrong' | null>(null)

  useEffect(() => {
    buildQueue(settings).then(setQueue)
  }, [settings])

  const item = queue?.[index]

  const advance = useCallback(() => {
    setRevealed(false)
    setGraded({})
    setTyped('')
    setTypedVerdict(null)
    setIndex((i) => i + 1)
    setSessionCount((c) => c + 1)
  }, [])

  // The language you have chosen to produce rather than merely recognise.
  const typedLang =
    settings.typedLang &&
    item?.cards.some((c) => c.lang === settings.typedLang)
      ? settings.typedLang
      : null
  const typedEntry = typedLang
    ? item?.entries.find((e) => e.lang === typedLang)
    : undefined

  function checkTyped() {
    if (!typedEntry) return
    setTypedVerdict(
      sameWord(typed, typedEntry.headword, typedEntry.lang) ? 'right' : 'wrong',
    )
    setRevealed(true)
  }

  const rate = useCallback(
    async (card: Card, grade: Grade) => {
      setGraded((g) => ({ ...g, [card.lang]: grade }))
      await gradeCard(card, grade, settings)
    },
    [settings],
  )

  // Space reveals, 1-4 grade the first ungraded language. Reviewing is the
  // thing you do most, so it should not require the mouse.
  useEffect(() => {
    if (!item) return
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return
      if (e.code === 'Space') {
        // While typing an answer, space is a space.
        if (!revealed && typedLang) return
        e.preventDefault()
        if (!revealed) setRevealed(true)
        else if (allGraded) advance()
        return
      }
      if (!revealed) return
      const n = Number(e.key)
      if (n >= 1 && n <= 4) {
        const next = item.cards.find((c) => graded[c.lang] === undefined)
        if (next) void rate(next, GRADES[n - 1] as Grade)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const allGraded = useMemo(
    () => !!item && item.cards.every((c) => graded[c.lang] !== undefined),
    [item, graded],
  )

  if (queue === null) {
    return <div className="panel muted">Building your queue…</div>
  }

  if (!item) {
    return (
      <div className="panel done">
        <h2>{sessionCount > 0 ? 'Session finished' : 'Nothing due'}</h2>
        <p className="muted">
          {sessionCount > 0
            ? `You reviewed ${sessionCount} word${sessionCount === 1 ? '' : 's'}.`
            : 'Add some words, or come back when something is due.'}
        </p>
        <button className="primary" onClick={onExit}>
          Back
        </button>
      </div>
    )
  }

  const prompt = item.entries.find((e) => e.lang === settings.nativeLang)
  const remaining = queue.length - index

  return (
    <div className="review">
      <div className="review-head">
        <span className="muted">{remaining} left</span>
        {item.isNew && <span className="badge new">new</span>}
        <button className="link" onClick={onExit}>
          Stop
        </button>
      </div>

      <div className="prompt" lang={LANG_BCP47[settings.nativeLang]}>
        <div
          className={`prompt-word ${RTL_LANGS.has(settings.nativeLang) ? 'rtl' : ''}`}
        >
          {prompt?.headword ?? item.concept.lemma}
        </div>
        {prompt?.meaning && <div className="prompt-gloss">{prompt.meaning}</div>}
        <div className="prompt-pos muted">{item.concept.pos}</div>
      </div>

      {!revealed ? (
        <div className="reveal-area">
          <p className="muted">
            Recall it in{' '}
            {item.cards.map((c) => LANG_NAMES[c.lang]).join(', ')}.
          </p>
          {typedLang && (
            <form
              className="typed"
              onSubmit={(e) => {
                e.preventDefault()
                checkTyped()
              }}
            >
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={`Write it in ${LANG_NAMES[typedLang]}`}
                lang={LANG_BCP47[typedLang]}
                autoFocus
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
              <p className="muted small">
                The article counts for Swedish and German — write{' '}
                <em>en hund</em>, not <em>hund</em>.
              </p>
            </form>
          )}
          <button className="primary big" onClick={() => (typedLang ? checkTyped() : setRevealed(true))}>
            Show answer <kbd>space</kbd>
          </button>
        </div>
      ) : (
        <>
          {typedVerdict && typedEntry && (
            <div className={`typed-verdict ${typedVerdict}`}>
              {typedVerdict === 'right' ? (
                <strong>Correct — you produced it, not just recognised it.</strong>
              ) : (
                <>
                  <strong>You wrote “{typed || '—'}”.</strong> The form to
                  produce is <em lang={LANG_BCP47[typedEntry.lang]}>{typedEntry.headword}</em>.
                </>
              )}
            </div>
          )}

          <div className="answers">
            {item.cards.map((card) => (
              <LanguageAnswer
                key={card.lang}
                card={card}
                item={item}
                settings={settings}
                grade={graded[card.lang]}
                onRate={(g) => void rate(card, g)}
              />
            ))}
          </div>

          <div className="next-bar">
            <button
              className="primary big"
              disabled={!allGraded}
              onClick={advance}
            >
              {allGraded ? (
                <>
                  Next <kbd>space</kbd>
                </>
              ) : (
                'Rate every language to continue'
              )}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function LanguageAnswer({
  card,
  item,
  settings,
  grade,
  onRate,
}: {
  card: Card
  item: QueueItem
  settings: Settings
  grade: Grade | undefined
  onRate: (g: Grade) => void
}) {
  const entry = item.entries.find((e) => e.lang === card.lang)
  const intervals = useMemo(
    () => previewIntervals(card, settings),
    [card, settings],
  )
  const lines = entry ? morphLines(card.lang, entry.morphology) : []
  const gender = entry ? genderBadge(card.lang, entry.morphology) : null
  const priority = settings.targetLangs.indexOf(card.lang as Lang) + 1

  return (
    <div className={`answer ${grade !== undefined ? 'rated' : ''}`}>
      <div className="answer-head">
        <span className="lang-chip">
          <span className="prio">{priority}</span>
          {LANG_NAMES[card.lang]}
        </span>
        {gender && <span className={`gender gender-${gender}`}>{gender}</span>}
      </div>

      <div className="answer-word" lang={LANG_BCP47[card.lang]}>
        {entry?.headword ?? '—'}
      </div>
      {entry?.meaning && <div className="answer-meaning">{entry.meaning}</div>}

      {lines.length > 0 && (
        <dl className="forms">
          {lines.map((l) => (
            <div key={l.label} className="form-row">
              <dt>{l.label}</dt>
              <dd lang={LANG_BCP47[card.lang]}>{l.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {entry?.example && (
        <div className="example" lang={LANG_BCP47[card.lang]}>
          {entry.example}
          {entry.exampleGloss && (
            <div
              className={`example-gloss ${RTL_LANGS.has(settings.nativeLang) ? 'rtl' : ''}`}
              lang={LANG_BCP47[settings.nativeLang]}
            >
              {entry.exampleGloss}
            </div>
          )}
        </div>
      )}
      {entry?.notes && <div className="note">{entry.notes}</div>}

      <div className="grades">
        {GRADES.map((g, i) => (
          <button
            key={g}
            className={`grade grade-${g} ${grade === g ? 'chosen' : ''}`}
            title={GRADE_HINTS[g]}
            onClick={() => onRate(g as Grade)}
            disabled={grade !== undefined}
          >
            <span className="grade-label">{GRADE_LABELS[g]}</span>
            <span className="grade-interval">{intervals[g]}</span>
            <kbd>{i + 1}</kbd>
          </button>
        ))}
      </div>
    </div>
  )
}


/**
 * Is what you typed the same word? Case and surrounding whitespace are noise,
 * and so are the diacritic-free spellings a phone keyboard produces, so "fodd"
 * is accepted for "född". Everything else — including the article, which is
 * half of what you are learning — has to match.
 */
function sameWord(typed: string, headword: string, _lang: Lang): boolean {
  const normalise = (s: string) =>
    s
      .trim()
      .toLocaleLowerCase()
      .replace(/\s+/g, ' ')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
  return normalise(typed) === normalise(headword)
}
