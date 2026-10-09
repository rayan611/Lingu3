import { useLiveQuery } from 'dexie-react-hooks'
import { computeStats, DAY, type Stats } from '../lib/stats'
import { LANG_NAMES, type Settings } from '../db/types'

/**
 * Who you are and how it is going.
 *
 * Every number here is derived from rows that already exist — concepts carry
 * `createdAt`, the review log is append-only — so nothing had to be stored to
 * make this screen, and nothing can drift out of step with what it counts.
 */
export function Profile({
  settings,
  email,
}: {
  settings: Settings
  email: string | null
}) {
  const stats = useLiveQuery(() => computeStats(settings), [settings])

  if (!stats) return <div className="panel muted">Counting…</div>

  const active = settings.targetLangs.filter((l) =>
    settings.activeLangs.includes(l),
  )

  return (
    <div className="stack">
      <div className="panel">
        <h2>{settings.displayName || 'Your profile'}</h2>
        <dl className="kv">
          <div>
            <dt>Native language</dt>
            <dd>{LANG_NAMES[settings.nativeLang]}</dd>
          </div>
          <div>
            <dt>Learning</dt>
            <dd>
              {active.map((l) => LANG_NAMES[l]).join(', ') || 'nothing active'}
            </dd>
          </div>
          {email && (
            <div>
              <dt>Account</dt>
              <dd>{email}</dd>
            </div>
          )}
          {stats.firstActivity && (
            <div>
              <dt>Reviewing since</dt>
              <dd>{new Date(stats.firstActivity).toLocaleDateString()}</dd>
            </div>
          )}
        </dl>
      </div>

      <div className="panel">
        <h3>At a glance</h3>
        <div className="stat-grid">
          <Stat label="Words" value={stats.words} />
          <Stat
            label="Started"
            value={stats.wordsStarted}
            hint="seen at least once"
          />
          <Stat label="Reviews" value={stats.reviews} />
          <Stat label="Today" value={stats.reviewsToday} />
          <Stat
            label="Streak"
            value={stats.streak}
            hint={`best ${stats.longestStreak}`}
          />
        </div>
      </div>

      <div className="panel">
        <h3>Words over time</h3>
        {stats.growth.length > 1 ? (
          <GrowthChart points={stats.growth} />
        ) : (
          <p className="muted small">
            Not enough history yet — this fills in as you add words.
          </p>
        )}
      </div>

      <div className="panel">
        <h3>Review days</h3>
        <Heatmap cells={stats.heatmap} />
        <p className="muted small">
          Last six months. Darker is more reviews that day.
        </p>
      </div>

      <div className="panel">
        <h3>By language</h3>
        <table className="stat-table">
          <thead>
            <tr>
              <th>Language</th>
              <th>Cards</th>
              <th>Due</th>
              <th>Learned</th>
              <th>Avg interval</th>
              <th>Lapses</th>
            </tr>
          </thead>
          <tbody>
            {stats.perLang.map((l) => (
              <tr key={l.lang} className={l.active ? '' : 'paused'}>
                <td>
                  {LANG_NAMES[l.lang]}
                  {!l.active && <span className="badge subtle">paused</span>}
                </td>
                <td>{l.cards}</td>
                <td>{l.due}</td>
                <td>{l.inReview}</td>
                <td>
                  {l.avgStability >= 1
                    ? `${Math.round(l.avgStability)}d`
                    : l.avgStability > 0
                      ? '<1d'
                      : '—'}
                </td>
                <td>{l.lapses}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string
  value: number
  hint?: string
}) {
  return (
    <div className="stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
      {hint && <span className="stat-hint">{hint}</span>}
    </div>
  )
}

/**
 * A plain SVG line. No chart library: this is one path and two labels, and the
 * stylesheet is deliberately a few kilobytes.
 */
function GrowthChart({ points }: { points: Stats['growth'] }) {
  const w = 320
  const h = 90
  const max = Math.max(...points.map((p) => p.total), 1)
  const step = points.length > 1 ? w / (points.length - 1) : w
  const d = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(h - (p.total / max) * h).toFixed(1)}`)
    .join(' ')

  return (
    <div className="growth">
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img"
        aria-label={`Words over time, now ${max}`}>
        <path d={`${d} L${w},${h} L0,${h} Z`} className="growth-fill" />
        <path d={d} className="growth-line" />
      </svg>
      <div className="growth-axis">
        <span className="muted small">
          {new Date(points[0].day).toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
          })}
        </span>
        <span className="muted small">{max} words</span>
      </div>
    </div>
  )
}

function Heatmap({ cells }: { cells: Stats['heatmap'] }) {
  const max = Math.max(...cells.map((c) => c.count), 1)
  // Pad the start so each column is a real week, Monday at the top.
  const firstDow = (new Date(cells[0].day).getDay() + 6) % 7
  const padded = [
    ...Array.from({ length: firstDow }, () => null),
    ...cells,
  ]

  return (
    <div className="heatmap">
      {padded.map((cell, i) =>
        cell === null ? (
          <span key={`pad-${i}`} className="heat heat-pad" />
        ) : (
          <span
            key={cell.day}
            className={`heat heat-${level(cell.count, max)}`}
            title={`${new Date(cell.day).toLocaleDateString()} — ${cell.count} review${cell.count === 1 ? '' : 's'}`}
          />
        ),
      )}
    </div>
  )
}

function level(count: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (count === 0) return 0
  const ratio = count / max
  if (ratio > 0.66) return 4
  if (ratio > 0.33) return 3
  if (ratio > 0.1) return 2
  return 1
}

export { DAY }
