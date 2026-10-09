import { useCallback, useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { adoptLocalData, db, ensureSettings, openForUser, readSettings } from './db/db'
import { queueCounts } from './fsrs/queue'
import { processPending } from './ai/expand'
import { LANG_NAMES, type Settings } from './db/types'
import { authConfigured } from './auth/supabase'
import { useSession } from './auth/useSession'
import { SignIn } from './auth/SignIn'
import { sync, type SyncResult } from './sync/sync'

/**
 * Sync outcomes that are not failures and must not raise a banner. `offline`
 * is the expected state on a train; `already running` just means two triggers
 * overlapped — the five-minute interval firing while a debounced write-sync is
 * still in flight — and the work is being done by the run that holds the lock.
 */
const BENIGN_SYNC_ERRORS = new Set(['offline', 'already running'])
import { AddWord } from './ui/AddWord'
import { Review } from './ui/Review'
import { Browse } from './ui/Browse'
import { Training } from './ui/Training'
import { StoryMode } from './ui/StoryMode'
import { SettingsPanel } from './ui/SettingsPanel'
import { InstallButton } from './ui/InstallButton'
import { NamePrompt } from './ui/NamePrompt'
import { Logo } from './ui/Logo'
import { applyTheme, readTheme } from './lib/theme'

/**
 * Profile is not here: it lives inside Settings now. Seven tabs did not fit a
 * phone without a sideways scroll that hid whichever tab you wanted, and of
 * the seven, Profile was the one you open monthly rather than daily.
 */
type Tab = 'add' | 'training' | 'read' | 'review' | 'browse' | 'settings'

export function App() {
  const { session, userId, email } = useSession()

  // Before first paint, so a dark-theme user does not get a white flash.
  useEffect(() => {
    applyTheme(readTheme())
  }, [])

  const [dbReady, setDbReady] = useState(false)
  const [dbKey, setDbKey] = useState('local')

  // Point Dexie at this user's store before rendering anything that queries it.
  useEffect(() => {
    if (session === undefined) return
    let cancelled = false
    ;(async () => {
      await openForUser(userId)
      if (userId) {
        // Anything added before signing in belongs to this account now.
        await adoptLocalData().catch(() => 0)
      }
      // Create the settings row here, once, rather than from a live query.
      await ensureSettings()
      if (!cancelled) {
        setDbKey(userId ?? 'local')
        setDbReady(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [session, userId])

  if (session === undefined) {
    return <div className="boot">Checking your session…</div>
  }

  if (authConfigured && !session) {
    return <SignIn />
  }

  if (!dbReady) {
    return <div className="boot">Opening your words…</div>
  }

  return <Workspace key={dbKey} userId={userId} email={email} />
}

function Workspace({
  userId,
  email,
}: {
  userId: string | null
  email: string | null
}) {
  const [tab, setTab] = useState<Tab>('add')
  const [online, setOnline] = useState(navigator.onLine)
  const [syncState, setSyncState] = useState<SyncResult | null>(null)
  const [syncing, setSyncing] = useState(false)
  const syncTimer = useRef<number | null>(null)
  const debounceTimer = useRef<number | null>(null)

  const settings = useLiveQuery(() => readSettings(), [])
  const counts = useLiveQuery(
    async () => (settings ? queueCounts(settings) : null),
    [settings],
  )
  useLiveQuery(() => db.cards.count(), [])

  /**
   * The most recent local write, used to sync shortly after you change
   * something rather than up to five minutes later. Both tables index
   * `updatedAt`, so this is one key lookup each and it re-fires on any write.
   */
  const lastWrite =
    useLiveQuery(async () => {
      const [concept, card] = await Promise.all([
        db.concepts.orderBy('updatedAt').last(),
        db.cards.orderBy('updatedAt').last(),
      ])
      return Math.max(concept?.updatedAt ?? 0, card?.updatedAt ?? 0)
    }, []) ?? 0

  useEffect(() => {
    const up = () => setOnline(true)
    const down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
    }
  }, [])

  const runSync = useCallback(async () => {
    if (!userId || !navigator.onLine) return
    setSyncing(true)
    const result = await sync(userId)
    setSyncState(result)
    setSyncing(false)
  }, [userId])

  // Sync on load, when the connection returns, and every few minutes. Reviewing
  // never waits on it — the app reads local data regardless.
  useEffect(() => {
    if (!userId) return
    void runSync()
    syncTimer.current = window.setInterval(() => void runSync(), 5 * 60_000)
    return () => {
      if (syncTimer.current) window.clearInterval(syncTimer.current)
    }
  }, [userId, runSync])

  useEffect(() => {
    if (online) void runSync()
  }, [online, runSync])

  /**
   * Sync when the app goes to the background.
   *
   * Not on exit: `beforeunload` frequently never fires on iOS, and a PWA that
   * is backgrounded and then killed by the system never sees it at all.
   * `visibilitychange` to hidden does fire — switching apps, locking the
   * phone, closing the tab — which is the moment that actually matters.
   */
  useEffect(() => {
    if (!userId) return
    const onHide = () => {
      if (document.visibilityState === 'hidden') void runSync()
    }
    document.addEventListener('visibilitychange', onHide)
    // A belt-and-braces second trigger for desktop browsers, where it is
    // reliable. Harmless where it is not: sync is idempotent.
    window.addEventListener('pagehide', onHide)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', onHide)
    }
  }, [userId, runSync])

  /**
   * And a few seconds after a local change, so a word added on the phone is on
   * the laptop by the time you get there. Debounced, because grading a card
   * writes once per language and a review session would otherwise be one sync
   * per keystroke.
   *
   * Safe to do often: sync is last-write-wins on `updatedAt` and the review
   * log is append-only, so running it more only shrinks the window in which
   * two devices can disagree.
   */
  useEffect(() => {
    if (!userId || lastWrite === 0) return
    if (debounceTimer.current) window.clearTimeout(debounceTimer.current)
    debounceTimer.current = window.setTimeout(() => void runSync(), 6000)
    return () => {
      if (debounceTimer.current) window.clearTimeout(debounceTimer.current)
    }
  }, [userId, lastWrite, runSync])

  useEffect(() => {
    if (!settings || !online) return
    void processPending(settings)
  }, [settings, online])

  if (!settings) return <div className="boot">Loading…</div>

  const due = counts?.total ?? 0

  return (
    <div className="app">
      {/* Three zones: who the app is, who you are, what you are studying.
          On a phone the greeting drops out before the other two, because the
          mark identifies the app and the language line is the one piece of
          state worth seeing on every screen. */}
      <header className="topbar">
        <div className="brand-block">
          <Logo />
          <span className="brand">Lingu3</span>
        </div>
        <div className="topbar-greeting">
          {settings.displayName && <span>Hej {settings.displayName}</span>}
        </div>
        <div className="topbar-meta">
          <span className="brand-sub">{learningLine(settings)}</span>
          {!online && <span className="badge offline">offline</span>}
          {syncing && <span className="badge subtle">syncing…</span>}
          {syncState?.error && !BENIGN_SYNC_ERRORS.has(syncState.error) && (
            <span className="badge warn-badge">sync failed</span>
          )}
          <InstallButton />
        </div>
      </header>

      {authConfigured && !settings.displayName && <NamePrompt />}

      {/* Ordered the way a session actually goes: add words, train them,
          read them, then test. The tab is called Test; the id, the route and
          review_log keep their names. Renaming the storage layer to match a
          label is how a sync bug gets shipped for nothing. */}
      <nav className="tabs">
        <TabButton id="add" tab={tab} set={setTab} icon="+">
          Add
        </TabButton>
        <TabButton id="training" tab={tab} set={setTab} icon="◎">
          Training
        </TabButton>
        <TabButton id="read" tab={tab} set={setTab} icon="▤">
          Reading
        </TabButton>
        <TabButton id="review" tab={tab} set={setTab} badge={due} icon="✓">
          Test
        </TabButton>
        <TabButton id="browse" tab={tab} set={setTab} icon="☰">
          Words
        </TabButton>
        <TabButton id="settings" tab={tab} set={setTab} icon="⚙">
          Settings
        </TabButton>
      </nav>

      {syncState?.error && !BENIGN_SYNC_ERRORS.has(syncState.error) && (
        <div className="sync-banner">
          <div>
            <strong>Sync didn't work.</strong>{' '}
            <span className="muted">
              Your words are safe on this device — this only affects the copy on
              the server.
            </span>
            <pre className="sync-banner-detail">{syncState.error}</pre>
          </div>
          <div className="row">
            <button onClick={() => void runSync()} disabled={syncing}>
              Try again
            </button>
            <button
              className="link"
              onClick={() => void navigator.clipboard?.writeText(syncState.error ?? '')}
            >
              Copy error
            </button>
          </div>
        </div>
      )}

      <main className="content">
        {tab === 'review' && (
          <ReviewTab settings={settings} onExit={() => setTab('add')} />
        )}
        {tab === 'training' && <Training settings={settings} />}
        {tab === 'read' && <StoryMode settings={settings} />}
        {tab === 'add' && <AddWord settings={settings} />}
        {tab === 'browse' && <Browse settings={settings} />}
        {tab === 'settings' && (
          <SettingsPanel
            settings={settings}
            email={email}
            syncState={syncState}
            syncing={syncing}
            onSync={runSync}
          />
        )}
      </main>
    </div>
  )
}

/**
 * "Learning Swedish, German and English" — but on a phone three full language
 * names wrap badly, so below a narrow width it is the codes instead.
 */
function learningLine(settings: Settings): string {
  const active = settings.targetLangs.filter((l) =>
    settings.activeLangs.includes(l),
  )
  if (active.length === 0) return 'no active language'
  const narrow =
    typeof window !== 'undefined' && window.innerWidth < 420 && active.length > 2
  const names = active.map((l) => (narrow ? l.toUpperCase() : LANG_NAMES[l]))
  const list =
    names.length > 1
      ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
      : names[0]
  return `Learning ${list}`
}

function ReviewTab({
  settings,
  onExit,
}: {
  settings: Settings
  onExit: () => void
}) {
  const [session, setSession] = useState(0)
  return (
    <Review
      key={session}
      settings={settings}
      onExit={() => {
        setSession((s) => s + 1)
        onExit()
      }}
    />
  )
}

function TabButton({
  id,
  tab,
  set,
  badge,
  icon,
  children,
}: {
  id: Tab
  tab: Tab
  set: (t: Tab) => void
  badge?: number
  icon: string
  children: React.ReactNode
}) {
  return (
    <button
      className={`tab ${tab === id ? 'active' : ''}`}
      onClick={() => set(id)}
      aria-current={tab === id ? 'page' : undefined}
    >
      <span className="tab-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="tab-label">{children}</span>
      {badge !== undefined && badge > 0 && <span className="tab-badge">{badge}</span>}
    </button>
  )
}
