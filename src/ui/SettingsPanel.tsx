import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, saveSettings } from '../db/db'
import { LANGS, LANG_NAMES, LANG_NATIVE_NAMES, type Lang, type Settings } from '../db/types'
import { authConfigured } from '../auth/supabase'
import { signOut } from '../auth/useSession'
import { resetSyncCursors, type SyncResult } from '../sync/sync'
import { THEMES, THEME_LABELS, readTheme, saveTheme, type Theme } from '../lib/theme'

interface SettingsPanelProps {
  settings: Settings
  email: string | null
  syncState: SyncResult | null
  syncing: boolean
  onSync: () => void | Promise<void>
}

export function SettingsPanel({
  settings,
  email,
  syncState,
  syncing,
  onSync,
}: SettingsPanelProps) {
  const [theme, setTheme] = useState<Theme>(() => readTheme())
  const [name, setName] = useState(settings.displayName ?? '')

  const cardCounts =
    useLiveQuery(async () => {
      const cards = await db.cards.toArray()
      const out: Record<string, number> = {}
      for (const c of cards) out[c.lang] = (out[c.lang] ?? 0) + 1
      return out
    }, []) ?? {}

  async function toggleActive(lang: Lang) {
    const on = settings.activeLangs.includes(lang)
    const next = on
      ? settings.activeLangs.filter((l) => l !== lang)
      : [...settings.activeLangs, lang]
    await saveSettings({ activeLangs: next })
  }

  async function move(lang: Lang, dir: -1 | 1) {
    const order = [...settings.targetLangs]
    const i = order.indexOf(lang)
    const j = i + dir
    if (i < 0 || j < 0 || j >= order.length) return
    ;[order[i], order[j]] = [order[j], order[i]]
    await saveSettings({ targetLangs: order })
  }

  /**
   * Three at a time, which is the name of the app and an honest limit rather
   * than a technical one: the schema is per (word x language) and does not
   * care, but four languages stacked on one review card is more than anyone
   * reads, and the interference research is about production anyway.
   */
  const MAX_TARGETS = 3
  const atLimit = settings.targetLangs.length >= MAX_TARGETS

  async function toggleTarget(lang: Lang) {
    const isTarget = settings.targetLangs.includes(lang)
    if (!isTarget && atLimit) return
    if (isTarget) {
      await saveSettings({
        targetLangs: settings.targetLangs.filter((l) => l !== lang),
        activeLangs: settings.activeLangs.filter((l) => l !== lang),
      })
    } else {
      await saveSettings({
        targetLangs: [...settings.targetLangs, lang],
        activeLangs: [...settings.activeLangs, lang],
      })
    }
  }

  const available = LANGS.filter((l) => l !== settings.nativeLang)

  return (
    <div className="stack">
      <div className="panel">
        <h2>You</h2>
        <label className="field">
          <span>Name</span>
          <div className="row">
            <input
              className="field-grow"
              value={name}
              maxLength={40}
              placeholder="Your name"
              onChange={(e) => setName(e.target.value)}
              onBlur={() =>
                void saveSettings({ displayName: name.trim() || undefined })
              }
            />
          </div>
          <span className="muted small">
            Shown at the top of the screen. Synced, so it follows your account.
          </span>
        </label>

        <label className="field">
          <span>Theme</span>
          <select
            value={theme}
            onChange={(e) => {
              const next = e.target.value as Theme
              setTheme(next)
              saveTheme(next)
            }}
          >
            {THEMES.map((t) => (
              <option key={t} value={t}>
                {THEME_LABELS[t]}
              </option>
            ))}
          </select>
          <span className="muted small">
            Kept on this device rather than synced — which theme suits you
            depends on the screen you are looking at, not on your account.
          </span>
        </label>
      </div>

      <div className="panel">
        <h2>Languages</h2>

        <label className="field">
          <span>Native language</span>
          <select
            value={settings.nativeLang}
            onChange={(e) => {
              const next = e.target.value as Lang
              const previous = settings.nativeLang
              // The language you are leaving becomes something you are
              // learning, rather than vanishing from the app entirely — which
              // is what used to happen, silently.
              const targets = settings.targetLangs.filter((l) => l !== next)
              const actives = settings.activeLangs.filter((l) => l !== next)
              void saveSettings({
                nativeLang: next,
                targetLangs: targets.includes(previous)
                  ? targets
                  : [...targets, previous],
                activeLangs: actives.includes(previous)
                  ? actives
                  : [...actives, previous],
                typedLang:
                  settings.typedLang === next ? undefined : settings.typedLang,
              })
            }}
          >
            {LANGS.map((l) => (
              <option key={l} value={l}>
                {LANG_NAMES[l]} — {LANG_NATIVE_NAMES[l]}
              </option>
            ))}
          </select>
        </label>

        <h3>Learning</h3>
        <p className="muted small">
          Order sets the stacking order on review cards. Pausing a language keeps
          its progress — it stops appearing, and resumes at the right interval
          when you switch it back on.
        </p>

        <ul className="lang-settings">
          {settings.targetLangs.map((lang, i) => {
            const active = settings.activeLangs.includes(lang)
            return (
              <li key={lang} className={active ? '' : 'paused'}>
                <span className="prio">{i + 1}</span>
                <span className="lang-settings-name">
                  {LANG_NAMES[lang]}
                  <span className="muted small">
                    {' '}
                    {cardCounts[lang] ?? 0} cards
                  </span>
                </span>
                <div className="lang-settings-actions">
                  <button onClick={() => void move(lang, -1)} disabled={i === 0}>
                    ↑
                  </button>
                  <button
                    onClick={() => void move(lang, 1)}
                    disabled={i === settings.targetLangs.length - 1}
                  >
                    ↓
                  </button>
                  <button
                    className={active ? 'toggle on' : 'toggle'}
                    onClick={() => void toggleActive(lang)}
                  >
                    {active ? 'studying' : 'paused'}
                  </button>
                  <button className="link danger" onClick={() => void toggleTarget(lang)}>
                    remove
                  </button>
                </div>
              </li>
            )
          })}
        </ul>

        {available.some((l) => !settings.targetLangs.includes(l)) && (
          <div className="row">
            <span className="muted small">
              {atLimit ? `${MAX_TARGETS} is the limit — remove one first:` : 'Add:'}
            </span>
            {available
              .filter((l) => !settings.targetLangs.includes(l))
              .map((l) => (
                <button
                  key={l}
                  className="chip"
                  disabled={atLimit}
                  onClick={() => void toggleTarget(l)}
                >
                  + {LANG_NAMES[l]}
                </button>
              ))}
          </div>
        )}
      </div>

      <div className="panel">
        <h2>Recall</h2>
        <label className="field">
          <span>Type the answer for</span>
          <select
            value={settings.typedLang ?? ''}
            onChange={(e) =>
              void saveSettings({
                typedLang: e.target.value ? (e.target.value as Lang) : undefined,
              })
            }
          >
            <option value="">No typing — just reveal</option>
            {settings.targetLangs.map((l) => (
              <option key={l} value={l}>
                {LANG_NAMES[l]}
              </option>
            ))}
          </select>
          <span className="muted small">
            Recognising a word and producing it are different skills, and
            interference between Swedish and German shows up in production. One
            language only, so a session stays short.
          </span>
        </label>
      </div>

      <div className="panel">
        <h2>Scheduling</h2>
        <label className="field">
          <span>New words per day</span>
          <input
            type="number"
            min={0}
            max={200}
            value={settings.dailyNewLimit}
            onChange={(e) =>
              void saveSettings({ dailyNewLimit: Number(e.target.value) })
            }
          />
        </label>
        <label className="field">
          <span>Reviews per day</span>
          <input
            type="number"
            min={10}
            max={1000}
            value={settings.dailyReviewLimit}
            onChange={(e) =>
              void saveSettings({ dailyReviewLimit: Number(e.target.value) })
            }
          />
        </label>
        <label className="field">
          <span>
            Target recall: {Math.round(settings.requestRetention * 100)}%
          </span>
          <input
            type="range"
            min={70}
            max={97}
            value={Math.round(settings.requestRetention * 100)}
            onChange={(e) =>
              void saveSettings({ requestRetention: Number(e.target.value) / 100 })
            }
          />
          <span className="muted small">
            Higher means shorter intervals and more reviews. 90% is the usual
            balance; below 80% you will forget noticeably more.
          </span>
        </label>
      </div>

      {authConfigured && (
        <div className="panel">
          <h2>Account</h2>
          <p className="muted small">Signed in as {email ?? 'unknown'}.</p>

          <h3>Sync</h3>
          <p className="muted small">
            Your words are stored on this device and copied to your account
            automatically — a few seconds after you change something, and again
            whenever the app goes to the background. Reviewing never waits for
            the network, and the button below is only here for when you want to
            be certain.
          </p>
          <p className="muted small">
            {syncing
              ? 'Syncing now…'
              : syncState
                ? syncState.error
                  ? `Last attempt failed: ${syncState.error}`
                  : `Last synced ${new Date(syncState.at).toLocaleTimeString()} — ${syncState.pushed} up, ${syncState.pulled} down.`
                : 'Not synced yet this session.'}
          </p>
          <div className="row">
            <button onClick={() => void onSync()} disabled={syncing}>
              Sync now
            </button>
            <button
              onClick={async () => {
                await resetSyncCursors()
                await onSync()
              }}
              disabled={syncing}
              title="Re-read everything from the server, in case something was missed"
            >
              Full resync
            </button>
            <button className="link danger" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </div>
      )}

      <div className="panel">
        <h2>Data</h2>
        <p className="muted small">
          Export gives you a copy you control — worth doing before clearing site
          data or changing browser.
        </p>
        <button onClick={() => void exportData()}>Export JSON</button>
      </div>

      {/* Which build is actually running. Without this there is no way to tell
          from a phone whether the service worker has picked up a new deploy —
          which, after a day lost to a cached login wall, is worth four lines. */}
      <p className="version-line">
        Lingu3 v{__APP_VERSION__} · built {__BUILD_DATE__}
      </p>
    </div>
  )
}

async function exportData() {
  const [concepts, entries, cards, reviewLog, settings] = await Promise.all([
    db.concepts.toArray(),
    db.entries.toArray(),
    db.cards.toArray(),
    db.reviewLog.toArray(),
    db.settings.toArray(),
  ])
  const blob = new Blob(
    [JSON.stringify({ version: 1, exportedAt: Date.now(), concepts, entries, cards, reviewLog, settings }, null, 2)],
    { type: 'application/json' },
  )
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `lingua-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(url)
}
