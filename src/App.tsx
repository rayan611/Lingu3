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
import { AddWord } from './ui/AddWord'
import { Review } from './ui/Review'
import { Browse } from './ui/Browse'
import { SettingsPanel } from './ui/SettingsPanel'

type Tab = 'review' | 'add' | 'browse' | 'settings'

export function App() {
  const { session, userId, email } = useSession()
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
  const [tab, setTab] = useState<Tab>('review')
  const [online, setOnline] = useState(navigator.onLine)
  const [syncState, setSyncState] = useState<SyncResult | null>(null)
  const [syncing, setSyncing] = useState(false)
  const syncTimer = useRef<number | null>(null)

  const settings = useLiveQuery(() => readSettings(), [])
  const counts = useLiveQuery(
    async () => (settings ? queueCounts(settings) : null),
    [settings],
  )
  useLiveQuery(() => db.cards.count(), [])

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

  useEffect(() => {
    if (!settings || !online) return
    void processPending(settings)
  }, [settings, online])

  if (!settings) return <div className="boot">Loading…</div>

  const due = counts?.total ?? 0

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">Lingua</div>
        <div className="topbar-meta">
          {!online && <span className="badge offline">offline</span>}
          {syncing && <span className="badge subtle">syncing…</span>}
          {syncState?.error && syncState.error !== 'offline' && (
            <span className="badge warn-badge">sync failed</span>
          )}
          <span className="muted small">
            {settings.targetLangs
              .filter((l) => settings.activeLangs.includes(l))
              .map((l) => LANG_NAMES[l])
              .join(' · ') || 'no active language'}
          </span>
        </div>
      </header>

      <nav className="tabs">
        <TabButton id="review" tab={tab} set={setTab} badge={due}>
          Review
        </TabButton>
        <TabButton id="add" tab={tab} set={setTab}>
          Add
        </TabButton>
        <TabButton id="browse" tab={tab} set={setTab}>
          Words
        </TabButton>
        <TabButton id="settings" tab={tab} set={setTab}>
          Settings
        </TabButton>
      </nav>

      {syncState?.error && syncState.error !== 'offline' && (
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
  children,
}: {
  id: Tab
  tab: Tab
  set: (t: Tab) => void
  badge?: number
  children: React.ReactNode
}) {
  return (
    <button className={`tab ${tab === id ? 'active' : ''}`} onClick={() => set(id)}>
      {children}
      {badge !== undefined && badge > 0 && <span className="tab-badge">{badge}</span>}
    </button>
  )
}
