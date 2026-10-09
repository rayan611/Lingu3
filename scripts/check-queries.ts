/**
 * Exercises every database query the UI performs, against a real schema.
 *
 * This exists because of a specific failure: both word lists sort concepts by
 * `createdAt`, which was never indexed, and IndexedDB refuses to sort on an
 * unindexed key. Typecheck and build both passed — index names are strings, so
 * nothing could catch it except running the query. So every query runs here.
 *
 * When you add a screen that queries the database, add its query below.
 *
 * Run with: npx tsx scripts/check-queries.ts
 */
import 'fake-indexeddb/auto'
import { db, openForUser, ensureSettings, compositeId, newId } from '../src/db/db'
import { makeCard } from '../src/fsrs/scheduler'
import { buildQueue, queueCounts } from '../src/fsrs/queue'
import type { Concept, Entry, Lang, ReviewLogRow } from '../src/db/types'

let failures = 0
async function check(label: string, run: () => Promise<unknown>) {
  try {
    await run()
    console.log(`  [PASS] ${label}`)
  } catch (err) {
    failures++
    console.log(`  [FAIL] ${label} — ${err instanceof Error ? err.message : err}`)
  }
}

const LANGS: Lang[] = ['sv', 'de', 'en']

async function seed() {
  const now = Date.now()
  const concepts: Concept[] = []
  const entries: Entry[] = []
  for (let i = 0; i < 5; i++) {
    const id = `concept-${i}`
    concepts.push({
      id,
      lemma: `word-${i}`,
      sourceLang: 'fa',
      pos: i % 2 ? 'verb' : 'noun',
      category: 'daily',
      createdAt: now - i * 1000,
      updatedAt: now - i * 1000,
    })
    for (const lang of ['fa', ...LANGS] as Lang[]) {
      entries.push({
        id: compositeId(id, lang),
        conceptId: id,
        lang,
        headword: `${lang}-word-${i}`,
        meaning: `meaning ${i}`,
        updatedAt: now,
      })
    }
    for (const lang of LANGS) await db.cards.put(makeCard(id, lang))
  }
  await db.concepts.bulkPut(concepts)
  await db.entries.bulkPut(entries)

  const log: ReviewLogRow = {
    id: newId(),
    cardId: compositeId('concept-0', 'sv'),
    conceptId: 'concept-0',
    lang: 'sv',
    grade: 3,
    state: 0,
    due: now,
    stability: 1,
    difficulty: 5,
    elapsedDays: 0,
    lastElapsedDays: 0,
    scheduledDays: 1,
    reviewedAt: now,
  }
  await db.reviewLog.put(log)
  await db.pending.put({
    id: newId(),
    conceptId: 'concept-1',
    attempts: 1,
    createdAt: now,
  })
}

async function main() {
  await openForUser('query-test-user')
  const settings = await ensureSettings()
  await seed()

  console.log('\nAdd screen')
  await check('recent words (concepts.orderBy createdAt)', () =>
    db.concepts.orderBy('createdAt').reverse().limit(6).toArray(),
  )
  await check('pending count', () => db.pending.count())
  await check('duplicate lookup (concepts.where sourceLang)', () =>
    db.concepts.where('sourceLang').equals('fa').first(),
  )

  console.log('\nWords screen')
  await check('full list (concepts.orderBy createdAt)', () =>
    db.concepts.orderBy('createdAt').reverse().toArray(),
  )
  await check('cards for a concept (cards.where conceptId)', () =>
    db.cards.where('conceptId').equals('concept-0').toArray(),
  )
  await check('entries for a concept (entries.where conceptId)', () =>
    db.entries.where('conceptId').equals('concept-0').toArray(),
  )

  console.log('\nReview screen')
  await check('queue counts (cards.where lang)', () => queueCounts(settings))
  await check('build queue', () => buildQueue(settings))
  await check('new-words-today (reviewLog.where reviewedAt)', () =>
    db.reviewLog.where('reviewedAt').aboveOrEqual(0).toArray(),
  )
  await check('entries + cards by anyOf', async () => {
    const ids = ['concept-0', 'concept-1']
    await db.entries.where('conceptId').anyOf(ids).toArray()
    await db.cards.where('conceptId').anyOf(ids).toArray()
  })

  console.log('\nSettings screen')
  await check('card counts per language', () => db.cards.toArray())
  await check('export reads every table', async () => {
    await Promise.all([
      db.concepts.toArray(),
      db.entries.toArray(),
      db.cards.toArray(),
      db.reviewLog.toArray(),
      db.settings.toArray(),
    ])
  })

  console.log('\nExpansion queue')
  await check('pending in order (pending.orderBy createdAt)', () =>
    db.pending.orderBy('createdAt').toArray(),
  )
  await check('pending by concept (pending.where conceptId)', () =>
    db.pending.where('conceptId').equals('concept-1').toArray(),
  )

  console.log('\nSync')
  await check('changed rows since a cursor', async () => {
    await db.concepts.filter((c) => c.updatedAt > 0).toArray()
    await db.entries.filter((e) => e.updatedAt > 0).toArray()
    await db.cards.filter((c) => c.updatedAt > 0).toArray()
    await db.reviewLog.filter((l) => l.reviewedAt > 0).toArray()
  })
  await check('bulkGet for the merge rule', () =>
    db.concepts.bulkGet(['concept-0', 'concept-1']),
  )

  console.log('\nAdding a language later')
  // A language with no morphology rules of its own must still work — it just
  // gets headword, meaning and example instead of tables of forms.
  const unknown = 'pl' as Lang
  await check('unknown language parses to no morphology, not a crash', async () => {
    const { parseMorphology } = await import('../src/db/types')
    const { morphLines, genderBadge } = await import('../src/lib/morphology')
    if (parseMorphology(unknown, { kind: 'noun', gender: 'der' }) !== undefined) {
      throw new Error('expected undefined for a language with no rules')
    }
    if (morphLines(unknown, undefined).length !== 0) throw new Error('expected no lines')
    if (genderBadge(unknown, undefined) !== null) throw new Error('expected no badge')
  })
  await check('cards and queue work for any language code', async () => {
    await db.cards.put(makeCard('concept-0', unknown))
    await db.cards.where('lang').anyOf([unknown]).toArray()
    await db.cards.delete(compositeId('concept-0', unknown))
  })

  console.log('\n8. Bulk add')
  await check('a pasted list parses into lemma + hint', async () => {
    const { parseBulkInput } = await import('../src/ai/expand')
    const lines = parseBulkInput('hund\n\nspringa, to run\n  bank - the river kind  \nhund\n')
    if (lines.length !== 3) throw new Error(`expected 3 lines, got ${lines.length}`)
    if (lines[1].lemma !== 'springa' || lines[1].hint !== 'to run') {
      throw new Error(`bad split: ${JSON.stringify(lines[1])}`)
    }
    if (lines[2].hint !== 'the river kind') {
      throw new Error(`dash hint not read: ${JSON.stringify(lines[2])}`)
    }
  })
  await check('bulk add queues concepts without expanding them', async () => {
    const { addWordsBulk } = await import('../src/ai/expand')
    const before = await db.pending.count()
    const res = await addWordsBulk({
      lines: [{ lemma: 'bulk-alpha' }, { lemma: 'bulk-beta', hint: 'a sense' }],
      sourceLang: 'sv',
      category: 'daily',
    })
    if (res.queued !== 2) throw new Error(`expected 2 queued, got ${res.queued}`)
    if ((await db.pending.count()) !== before + 2) {
      throw new Error('pending rows were not written')
    }
    // No cards yet: expansion has not run, so nothing is schedulable.
    const added = await db.concepts.where('lemma').equals('bulk-alpha').first()
    if (!added) throw new Error('concept missing')
    if ((await db.cards.where('conceptId').equals(added.id).count()) !== 0) {
      throw new Error('bulk add must not create cards before expansion')
    }
  })
  await check('a word already in the list is skipped, not duplicated', async () => {
    const { addWordsBulk } = await import('../src/ai/expand')
    const res = await addWordsBulk({
      lines: [{ lemma: 'bulk-alpha' }],
      sourceLang: 'sv',
      category: 'daily',
    })
    if (res.queued !== 0 || res.duplicates.length !== 1) {
      throw new Error(`expected a duplicate, got ${JSON.stringify(res)}`)
    }
  })

  console.log('\n12. Profile statistics')
  await check('stats compute from existing rows and never write', async () => {
    const { computeStats } = await import('../src/lib/stats')
    const settings = await ensureSettings()
    const before = await db.reviewLog.count()
    const stats = await computeStats(settings)
    if (await db.reviewLog.count() !== before) {
      throw new Error('computing stats must not write anything')
    }
    if (stats.words !== (await db.concepts.filter((c) => !c.deletedAt).count())) {
      throw new Error(`word count disagrees: ${stats.words}`)
    }
    if (stats.perLang.length !== settings.targetLangs.length) {
      throw new Error('one row per target language')
    }
    if (stats.heatmap.length !== 182) {
      throw new Error(`heatmap should cover the window, got ${stats.heatmap.length}`)
    }
  })
  await check('the growth line starts from words already held, not zero', async () => {
    const { computeStats } = await import('../src/lib/stats')
    const settings = await ensureSettings()
    // A one-day window: everything was added before it, so the first point
    // must already be the full total rather than restarting the count.
    const stats = await computeStats(settings, 1)
    if (stats.growth[0].total !== stats.words) {
      throw new Error(
        `expected the line to open at ${stats.words}, got ${stats.growth[0].total}`,
      )
    }
  })
  await check('a deleted word leaves the counts', async () => {
    const { computeStats } = await import('../src/lib/stats')
    const settings = await ensureSettings()
    const before = (await computeStats(settings)).words
    const victim = await db.concepts.where('lemma').equals('bulk-beta').first()
    if (!victim) throw new Error('fixture missing')
    await db.concepts.put({ ...victim, deletedAt: Date.now() })
    const after = (await computeStats(settings)).words
    if (after !== before - 1) throw new Error(`expected ${before - 1}, got ${after}`)
    await db.concepts.put({ ...victim, deletedAt: undefined })
  })

  console.log('\n11. Training is read-only')
  await check('browsing never touches FSRS state', async () => {
    // The whole value of Training depends on this. If stepping through words
    // wrote to cards or the review log, every interval would inflate and the
    // scheduler would stop meaning anything.
    const settings = await ensureSettings()
    const before = {
      cards: await db.cards.count(),
      logs: await db.reviewLog.count(),
      newest: (await db.cards.orderBy('updatedAt').last())?.updatedAt ?? 0,
    }

    // Exactly the queries the Training screen runs.
    const concepts = await db.concepts.orderBy('createdAt').reverse().toArray()
    concepts.filter((c) => !c.deletedAt)
    await db.cards.where('lang').anyOf(settings.activeLangs as string[]).toArray()

    const after = {
      cards: await db.cards.count(),
      logs: await db.reviewLog.count(),
      newest: (await db.cards.orderBy('updatedAt').last())?.updatedAt ?? 0,
    }
    if (after.cards !== before.cards) throw new Error('cards were created')
    if (after.logs !== before.logs) throw new Error('a review was logged')
    if (after.newest !== before.newest) throw new Error('a card was updated')
  })

  console.log('\n10. Topic tags')
  await check('the multiEntry tags index is queryable', async () => {
    // Index names are strings; only running the query proves the index exists.
    // This is the same class of bug as the missing `createdAt` index.
    await db.concepts.put({
      id: 'tagged-1',
      lemma: 'tagged',
      sourceLang: 'sv',
      pos: 'noun',
      category: 'daily',
      tags: ['restaurant', 'work'],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    const byTag = await db.concepts.where('tags').equals('work').toArray()
    if (!byTag.some((c) => c.id === 'tagged-1')) {
      throw new Error('multiEntry lookup missed a concept carrying the tag')
    }
    const other = await db.concepts.where('tags').equals('restaurant').toArray()
    if (!other.some((c) => c.id === 'tagged-1')) {
      throw new Error('a concept must be findable under each of its tags')
    }
  })
  await check('topic matching honours both tags and the legacy category', async () => {
    const { matchesTopic } = await import('../src/fsrs/queue')
    const tagged = (await db.concepts.get('tagged-1'))!
    const legacy = (await db.concepts.get('concept-0'))!
    if (!matchesTopic(tagged, 'work')) throw new Error('tag not matched')
    if (!matchesTopic(legacy, 'daily')) throw new Error('legacy category not matched')
    if (matchesTopic(tagged, 'travel')) throw new Error('matched a topic it lacks')
    if (!matchesTopic(tagged, 'all')) throw new Error('"all" must match everything')
  })
  await check('a topic filter narrows the queue without changing what is due', async () => {
    const settings = await ensureSettings()
    const all = await queueCounts(settings)
    const focused = await queueCounts(settings, 'travel')
    if (focused.total > all.total) {
      throw new Error('a filter cannot increase the number due')
    }
    const queue = await buildQueue(settings, 60, 'travel')
    if (queue.length > (await buildQueue(settings)).length) {
      throw new Error('a filtered queue cannot be longer than the whole one')
    }
  })

  console.log('\n9. Check before adding')
  await check('a word you already have is caught before any model call', async () => {
    const { previewWord, cachedPreviewCount, clearPreviewCache } = await import(
      '../src/ai/expand'
    )
    clearPreviewCache()
    const settings = await ensureSettings()
    const res = await previewWord({
      lemma: 'word-0',
      sourceLang: 'fa',
      settings,
    })
    if (res.status !== 'duplicate') {
      throw new Error('expected the existing word to be recognised')
    }
    // The decisive part: it did not reach the network, so nothing was cached.
    if (cachedPreviewCount() !== 0) throw new Error('a duplicate must cost nothing')
  })
  await check('committing a preview writes entries and cards, not a second call', async () => {
    const { commitPreview } = await import('../src/ai/expand')
    const settings = await ensureSettings()
    const result = await commitPreview({
      preview: {
        lemma: 'previewed',
        sourceLang: 'sv',
        expansion: {
          pos: 'noun',
          entries: [
            { lang: 'fa', headword: 'سگ', meaning: 'dog' },
            { lang: 'sv', headword: 'en hund', meaning: 'dog' },
            { lang: 'de', headword: 'der Hund', meaning: 'dog' },
            { lang: 'en', headword: 'dog', meaning: 'dog' },
          ],
        },
        
      },
      category: 'daily',
      settings,
    })
    if (result.status !== 'expanded') throw new Error(`got ${result.status}`)
    const entries = await db.entries.where('conceptId').equals(result.conceptId).count()
    if (entries !== 4) throw new Error(`expected 4 entries, got ${entries}`)
    const cards = await db.cards.where('conceptId').equals(result.conceptId).count()
    if (cards !== 3) throw new Error(`expected 3 cards, got ${cards}`)
    const concept = await db.concepts.get(result.conceptId)
    if (concept?.pos !== 'noun') throw new Error('pos from the expansion was not kept')
  })

  console.log(
    failures === 0
      ? '\nEvery UI query runs against the schema.\n'
      : `\n${failures} quer${failures === 1 ? 'y' : 'ies'} failed.\n`,
  )
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
