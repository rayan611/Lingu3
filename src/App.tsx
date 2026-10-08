import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, getSettings } from './db/db'
import { queueCounts } from './fsrs/queue'
import { processPending } from './ai/expand'
import { LANG_NAMES, type Settings } from './db/types'
import { AddWord } from './ui/AddWord'
import { Review } from './ui/Review'
import { Browse } from './ui/Browse'
import { SettingsPanel } from './ui/SettingsPanel'

type Tab = 'review' | 'add' | 'browse' | 'settings'

export function App() {
  const [tab, setTab] = useState<Tab>('review')
  const [online, setOnline] = useState(navigator.onLine)

  const settings = useLiveQuery(() => getSettings(), [])
  const counts = useLiveQuery(
    async () => (settings ? queueCounts(settings) : null),
    [settings],
  )
  // Re-read on card changes so the badge reflects the session as it happens.
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

  // Drain the pending queue whenever we have both a connection and settings.
  useEffect(() => {
    if (!settings || !online) return
    void processPending(settings)
  }, [settings, online])

  if (!settings) {
    return <div className="boot">Loading…</div>
  }

  const due = counts?.total ?? 0

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">Lingua</div>
        <div className="topbar-meta">
          {!online && <span className="badge offline">offline</span>}
          <span className="muted small">
            {settings.activeLangs.length > 0
              ? settings.targetLangs
                  .filter((l) => settings.activeLangs.includes(l))
                  .map((l) => LANG_NAMES[l])
                  .join(' · ')
              : 'no active language'}
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

      <main className="content">
        {tab === 'review' && (
          <ReviewTab settings={settings} onExit={() => setTab('add')} />
        )}
        {tab === 'add' && <AddWord settings={settings} />}
        {tab === 'browse' && <Browse settings={settings} />}
        {tab === 'settings' && <SettingsPanel settings={settings} />}
      </main>
    </div>
  )
}

/** Remount the reviewer on every entry so it always builds a fresh queue. */
function ReviewTab({ settings, onExit }: { settings: Settings; onExit: () => void }) {
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
