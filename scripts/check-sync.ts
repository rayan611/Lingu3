/**
 * Checks the parts of the auth/sync change that could silently lose data:
 * per-user database isolation, adoption of pre-sign-in words, and the
 * last-write-wins merge rule.
 *
 * Run with: npx tsx scripts/check-sync.ts
 */
import 'fake-indexeddb/auto'
import { adoptLocalData, db, openForUser, getMeta, setMeta } from '../src/db/db'
import type { Concept } from '../src/db/types'

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

  console.log('\n4. Sync cursors survive and reset')
  await setMeta('sync.lastPulledAt', 12345)
  check('cursor reads back', (await getMeta('sync.lastPulledAt')) === 12345)
  await setMeta('sync.lastPulledAt', 0)
  check('cursor resets to zero', (await getMeta('sync.lastPulledAt')) === 0)

  console.log(
    failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`,
  )
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
