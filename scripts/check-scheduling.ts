/**
 * Behavioural check for the thing that matters most in v1: that each language
 * on a card is scheduled independently, and that pausing a language freezes it
 * rather than losing it.
 *
 * Run with: npx tsx scripts/check-scheduling.ts
 */
import 'fake-indexeddb/auto'
import { Rating, State } from 'ts-fsrs'
import { db, getSettings, saveSettings } from '../src/db/db'
import { makeCard, gradeCard } from '../src/fsrs/scheduler'
import { buildQueue } from '../src/fsrs/queue'
import type { Concept, Entry, Lang } from '../src/db/types'

let failures = 0
function check(label: string, condition: boolean, detail = '') {
  const mark = condition ? 'PASS' : 'FAIL'
  if (!condition) failures++
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const DAY = 86_400_000

async function seed(lemma: string, langs: Lang[]) {
  const id = `c-${lemma}`
  const concept: Concept = {
    id,
    lemma,
    sourceLang: 'fa',
    pos: 'noun',
    category: 'daily',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  await db.concepts.put(concept)
  const entries: Entry[] = [['fa', lemma] as const, ...langs.map((l) => [l, `${lemma}-${l}`] as const)].map(
    ([lang, head]) => ({
      id: `${id}:${lang}`,
      conceptId: id,
      lang: lang as Lang,
      headword: head,
      meaning: `meaning of ${head}`,
      updatedAt: Date.now(),
    }),
  )
  await db.entries.bulkPut(entries)
  for (const lang of langs) await db.cards.put(makeCard(id, lang))
  return id
}

async function main() {
  const settings = await getSettings()
  console.log('\n1. Independent scheduling per language')
  const id = await seed('sag', ['sv', 'de', 'en'])

  let sv = (await db.cards.get(`${id}:sv`))!
  let de = (await db.cards.get(`${id}:de`))!
  let en = (await db.cards.get(`${id}:en`))!

  check('all three start New', [sv, de, en].every((c) => c.state === State.New))

  // Same word, three different outcomes — the case the single-score design
  // could not represent.
  sv = await gradeCard(sv, Rating.Good, settings)
  de = await gradeCard(de, Rating.Again, settings)
  en = await gradeCard(en, Rating.Easy, settings)

  check(
    'German (rated Again) is due sooner than Swedish (Good)',
    de.due < sv.due,
    `de=+${Math.round((de.due - Date.now()) / 60000)}m sv=+${Math.round((sv.due - Date.now()) / 60000)}m`,
  )
  check(
    'English (rated Easy) is due latest',
    en.due > sv.due && en.due > de.due,
    `en=+${Math.round((en.due - Date.now()) / DAY)}d`,
  )
  check('three separate log rows written', (await db.reviewLog.count()) === 3)

  console.log('\n2. Queue is driven by the worst-rated language')
  // Push all three well into the future, then pull German back to now.
  for (const c of [sv, de, en]) {
    await db.cards.put({ ...c, due: Date.now() + 30 * DAY })
  }
  let queue = await buildQueue(settings)
  check('nothing due -> empty queue', queue.length === 0)

  await db.cards.put({ ...(await db.cards.get(`${id}:de`))!, due: Date.now() - 1000 })
  queue = await buildQueue(settings)
  check('one overdue language surfaces the whole word', queue.length === 1)
  check(
    'and the card still shows all three languages',
    queue[0]?.cards.length === 3,
    `got ${queue[0]?.cards.length}`,
  )

  console.log('\n3. Pausing a language freezes it instead of losing it')
  const deBefore = (await db.cards.get(`${id}:de`))!
  await saveSettings({ activeLangs: ['sv', 'en'] })
  const paused = await getSettings()

  queue = await buildQueue(paused)
  check('paused language no longer pulls the word into the queue', queue.length === 0)

  const deAfter = (await db.cards.get(`${id}:de`))!
  check(
    'paused card keeps its stability and reps',
    deAfter.stability === deBefore.stability && deAfter.reps === deBefore.reps,
    `stability ${deAfter.stability.toFixed(3)}, reps ${deAfter.reps}`,
  )

  await saveSettings({ activeLangs: ['sv', 'de', 'en'] })
  const resumed = await getSettings()
  queue = await buildQueue(resumed)
  check('resumes at its old interval when switched back on', queue.length === 1)
  check(
    'and did not restart as New',
    (await db.cards.get(`${id}:de`))!.state !== State.New,
  )

  console.log('\n4. Daily new-word limit counts words, not cards')
  await saveSettings({ dailyNewLimit: 2, activeLangs: ['sv', 'de', 'en'] })
  const limited = await getSettings()
  await db.reviewLog.clear()
  for (const w of ['alpha', 'beta', 'gamma', 'delta']) await seed(w, ['sv', 'de', 'en'])
  // Clear the first word so only the four new ones are in play.
  await db.cards.where('conceptId').equals(id).delete()

  const q = await buildQueue(limited)
  check('four new words with a limit of 2 yields 2', q.length === 2, `got ${q.length}`)
  check(
    'each carries three language cards (3 x 2 = 6 cards, not 2)',
    q.every((i) => i.cards.length === 3),
  )

  console.log(
    failures === 0
      ? '\nAll checks passed.\n'
      : `\n${failures} check(s) failed.\n`,
  )
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
