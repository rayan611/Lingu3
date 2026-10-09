/**
 * Checks the parts of the auth/sync change that could silently lose data:
 * per-user database isolation, adoption of pre-sign-in words, and the
 * last-write-wins merge rule.
 *
 * Run with: npx tsx scripts/check-sync.ts
 */
import 'fake-indexeddb/auto'
import { adoptLocalData, db, openForUser, getMeta, setMeta, readSettings, ensureSettings } from '../src/db/db'
import type { Concept } from '../src/db/types'
import {
  ExpiringLock,
  advanceCursor,
  withTimeout,
  STALE_LOCK_MS,
} from '../src/sync/sync'

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

function concept(id: string, lemma: string, updatedAt = Date.now()): Concept {
  return {
    id,
    lemma,
    sourceLang: 'fa',
    pos: 'noun',
    category: 'daily',
    createdAt: updatedAt,
    updatedAt,
  }
}

async function main() {
  console.log('\n1. Words added before signing in are not lost')
  await openForUser(null)
  await db.concepts.bulkPut([concept('a', 'hund'), concept('b', 'katt')])
  check('two words in the local store', (await db.concepts.count()) === 2)

  await openForUser('user-1')
  const adopted = await adoptLocalData()
  check('adoption reports the words it moved', adopted === 2, `got ${adopted}`)
  check("they are in user-1's store", (await db.concepts.count()) === 2)

  await openForUser(null)
  check('and the local store is now empty', (await db.concepts.count()) === 0)

  console.log('\n2. Two users on one browser stay separate')
  await openForUser('user-1')
  check('user-1 still has their words', (await db.concepts.count()) === 2)
  await openForUser('user-2')
  check('user-2 starts empty', (await db.concepts.count()) === 0)
  await db.concepts.put(concept('c', 'bok'))
  await openForUser('user-1')
  check(
    "user-2's word did not leak into user-1",
    (await db.concepts.get('c')) === undefined,
  )
  check('user-1 count unchanged', (await db.concepts.count()) === 2)

  console.log('\n3. Last-write-wins keeps the newer side')
  const older = 1_000_000
  const newer = 2_000_000
  await db.concepts.put(concept('lww', 'local-newer', newer))

  // Simulate the merge rule used by pull(): remote wins only if strictly newer.
  const remoteOlder = concept('lww', 'remote-older', older)
  const local = await db.concepts.get('lww')
  const remoteWins = !local || remoteOlder.updatedAt > local.updatedAt
  check('an older remote row does not overwrite a newer local one', !remoteWins)

  const remoteNewer = concept('lww', 'remote-newer', newer + 1)
  const local2 = await db.concepts.get('lww')
  check(
    'a newer remote row does win',
    !!local2 && remoteNewer.updatedAt > local2.updatedAt,
  )

  console.log('\n4. Reading settings never writes')
  // A live query that writes re-triggers itself. This is what left a fresh
  // database spinning instead of rendering, so it gets a guard.
  await openForUser('user-3')
  const writesBefore = await db.settings.count()
  const first = await readSettings()
  const writesAfter = await db.settings.count()
  check('readSettings returns usable defaults on an empty db', first.targetLangs.length > 0)
  check(
    'and writes nothing',
    writesBefore === 0 && writesAfter === 0,
    `rows before ${writesBefore}, after ${writesAfter}`,
  )
  await ensureSettings()
  check('ensureSettings does create the row', (await db.settings.count()) === 1)
  await ensureSettings()
  check('and is idempotent', (await db.settings.count()) === 1)

  console.log('\n5. Sync cursors survive and reset')
  await setMeta('sync.lastPulledAt', 12345)
  check('cursor reads back', (await getMeta('sync.lastPulledAt')) === 12345)
  await setMeta('sync.lastPulledAt', 0)
  check('cursor resets to zero', (await getMeta('sync.lastPulledAt')) === 0)

  console.log('\n6. A hung sync cannot hold the lock forever')
  // The bug this guards: `running` was only cleared in a `finally`, so a fetch
  // frozen by the OS when the tab was backgrounded held it for the life of the
  // page and every later sync answered 'already running' until a reload.
  const lock = new ExpiringLock(STALE_LOCK_MS)
  const t0 = 1_000_000
  check('a free lock is acquired', lock.acquire(t0))
  check('a held lock refuses a second caller', !lock.acquire(t0 + 1000))
  check(
    'and still refuses just before it goes stale',
    !lock.acquire(t0 + STALE_LOCK_MS - 1),
  )
  check(
    'but a lock older than the stale window is taken over',
    lock.acquire(t0 + STALE_LOCK_MS),
  )
  lock.release()
  check('a released lock is free again', lock.acquire(t0 + STALE_LOCK_MS + 1))

  console.log('\n7. A step that never settles is abandoned')
  const hang = new Promise<number>(() => {})
  let timedOut = ''
  try {
    await withTimeout(hang, 20, 'push')
  } catch (err) {
    timedOut = err instanceof Error ? err.message : String(err)
  }
  check('withTimeout rejects rather than hanging', timedOut === 'push timed out', timedOut)

  const quick = await withTimeout(Promise.resolve(7), 1000, 'pull')
  check('and passes a value straight through when it settles', quick === 7)

  console.log('\n8. Cursors only ever move forward')
  // An abandoned push keeps running and may finish after a later sync has
  // already moved the cursor past its own startedAt. Writing that older value
  // would re-send a window of rows for nothing.
  await setMeta('sync.lastPushedAt', 0)
  await advanceCursor('sync.lastPushedAt', 5000)
  check('a fresh cursor advances', (await getMeta('sync.lastPushedAt')) === 5000)
  await advanceCursor('sync.lastPushedAt', 9000)
  check('a newer value advances it', (await getMeta('sync.lastPushedAt')) === 9000)
  await advanceCursor('sync.lastPushedAt', 3000)
  check(
    'a stale value from an abandoned run leaves it alone',
    (await getMeta('sync.lastPushedAt')) === 9000,
    `got ${await getMeta('sync.lastPushedAt')}`,
  )
  await setMeta('sync.lastPushedAt', 0)
  check(
    'and the reset path can still force it back to zero',
    (await getMeta('sync.lastPushedAt')) === 0,
  )

  console.log(
    failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`,
  )
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
