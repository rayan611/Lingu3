import { useLiveQuery } from 'dexie-react-hooks'
import { db, saveSettings } from '../db/db'
import { LANGS, LANG_NAMES, LANG_NATIVE_NAMES, type Lang, type Settings } from '../db/types'

export function SettingsPanel({ settings }: { settings: Settings }) {
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

  async function toggleTarget(lang: Lang) {
    const isTarget = settings.targetLangs.includes(lang)
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
        <h2>Languages</h2>

        <label className="field">
          <span>Native language</span>
          <select
            value={settings.nativeLang}
            onChange={(e) => {
              const next = e.target.value as Lang
              void saveSettings({
                nativeLang: next,
                targetLangs: settings.targetLangs.filter((l) => l !== next),
                activeLangs: settings.activeLangs.filter((l) => l !== next),
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
            <span className="muted small">Add:</span>
            {available
              .filter((l) => !settings.targetLangs.includes(l))
              .map((l) => (
                <button key={l} className="chip" onClick={() => void toggleTarget(l)}>
                  + {LANG_NAMES[l]}
                </button>
              ))}
          </div>
        )}
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

      <div className="panel">
        <h2>Data</h2>
        <p className="muted small">
          Everything lives in this browser. Export before clearing site data or
          switching device — cloud sync is not built yet.
        </p>
        <button onClick={() => void exportData()}>Export JSON</button>
      </div>
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
