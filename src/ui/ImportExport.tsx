import { useMemo, useState } from 'react'
import { db } from '../db/db'
import { addWordsBulk, processPending, type BulkLine } from '../ai/expand'
import {
  downloadCsv,
  looksLikeHeader,
  parseDelimited,
  sniffDelimiter,
  toCsv,
} from '../lib/csv'
import { LANG_NAMES, type Lang, type Settings } from '../db/types'

type ColumnRole = 'ignore' | 'word' | 'hint' | 'topic'

const ROLE_LABELS: Record<ColumnRole, string> = {
  ignore: 'ignore',
  word: 'the word',
  hint: 'sense / hint',
  topic: 'topic',
}

/**
 * Import a word list from a file, and export yours.
 *
 * Deliberately CSV rather than Anki's .apkg — see src/lib/csv.ts for why. The
 * upshot is that this one importer covers an Anki plain-text export, a Quizlet
 * export, a spreadsheet and a list typed in class, where .apkg parsing would
 * have covered one of those at several times the work.
 *
 * Nothing here calls the model. Rows go into the same pending queue as bulk
 * add, which already handles rate limits, retries and going offline.
 */
export function ImportExport({ settings }: { settings: Settings }) {
  const [rows, setRows] = useState<string[][] | null>(null)
  const [filename, setFilename] = useState('')
  const [hasHeader, setHasHeader] = useState(true)
  const [roles, setRoles] = useState<ColumnRole[]>([])
  const [sourceLang, setSourceLang] = useState<Lang>(settings.nativeLang)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  async function pick(file: File) {
    const text = await file.text()
    const parsed = parseDelimited(text, sniffDelimiter(text))
    if (parsed.length === 0) {
      setStatus('That file had no rows in it.')
      return
    }
    const header = looksLikeHeader(parsed[0])
    setRows(parsed)
    setFilename(file.name)
    setHasHeader(header)
    setStatus(null)

    // A first guess at what each column is. The first non-empty column is
    // almost always the word; a column headed "meaning" or "tag" names itself.
    const width = Math.max(...parsed.map((r) => r.length))
    const guess: ColumnRole[] = []
    for (let i = 0; i < width; i++) {
      const name = (header ? parsed[0][i] : '')?.toLocaleLowerCase() ?? ''
      if (/tag|topic|categ|deck/.test(name)) guess.push('topic')
      else if (/mean|transl|defin|hint|sense|back|note/.test(name))
        guess.push('hint')
      else if (i === 0) guess.push('word')
      else guess.push('ignore')
    }
    if (!guess.includes('word')) guess[0] = 'word'
    setRoles(guess)
  }

  const body = useMemo(
    () => (rows ? (hasHeader ? rows.slice(1) : rows) : []),
    [rows, hasHeader],
  )

  const lines: BulkLine[] = useMemo(() => {
    const wordCol = roles.indexOf('word')
    if (wordCol < 0) return []
    const hintCol = roles.indexOf('hint')
    const topicCol = roles.indexOf('topic')
    const out: BulkLine[] = []
    for (const row of body) {
      const lemma = (row[wordCol] ?? '').trim()
      if (!lemma) continue
      out.push({
        lemma,
        hint: hintCol >= 0 ? (row[hintCol] || undefined) : undefined,
        tags:
          topicCol >= 0 && row[topicCol]
            ? row[topicCol].split(/[,;|]/).map((t) => t.trim()).filter(Boolean)
            : undefined,
      })
    }
    return out
  }, [body, roles])

  async function run() {
    if (lines.length === 0 || busy) return
    setBusy(true)
    setStatus(null)
    try {
      const added = await addWordsBulk({ lines, sourceLang, category: 'daily' })
      let text = `Queued ${added.queued} of ${lines.length}.`
      if (added.duplicates.length) {
        text += ` ${added.duplicates.length} already in your list.`
      }
      setStatus(text)
      setRows(null)
      if (added.queued > 0 && navigator.onLine) {
        const { done, failed } = await processPending(settings)
        setStatus(
          `${text} Expanded ${done}${failed ? `, ${failed} still waiting` : ''}.`,
        )
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel">
      <h2>Import and export</h2>

      <h3>Bring a word list in</h3>
      <p className="muted small">
        A CSV or tab-separated file: a spreadsheet, a Quizlet export, or Anki's
        own “Notes in Plain Text”. Anki's .apkg is not supported — it is a
        zipped, zstd-compressed SQLite database whose fields have no fixed
        meaning, so there would be nothing reliable to map. Export from Anki as
        text instead.
      </p>

      <input
        type="file"
        accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
        disabled={busy}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void pick(file)
          e.target.value = ''
        }}
      />

      {rows && (
        <>
          <p className="muted small">
            {filename} — {body.length} row{body.length === 1 ? '' : 's'}. Tell me
            what each column is.
          </p>

          <label className="checkline">
            <input
              type="checkbox"
              checked={hasHeader}
              onChange={(e) => setHasHeader(e.target.checked)}
            />
            <span>The first row is column names, not a word</span>
          </label>

          <div className="import-table-wrap">
            <table className="import-table">
              <thead>
                <tr>
                  {roles.map((role, i) => (
                    <th key={i}>
                      <select
                        value={role}
                        onChange={(e) =>
                          setRoles((r) =>
                            r.map((x, j) =>
                              j === i ? (e.target.value as ColumnRole) : x,
                            ),
                          )
                        }
                      >
                        {(Object.keys(ROLE_LABELS) as ColumnRole[]).map((o) => (
                          <option key={o} value={o}>
                            {ROLE_LABELS[o]}
                          </option>
                        ))}
                      </select>
                      {hasHeader && rows[0][i] && (
                        <div className="muted small">{rows[0][i]}</div>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {body.slice(0, 4).map((row, i) => (
                  <tr key={i}>
                    {roles.map((_, j) => (
                      <td key={j}>{row[j] ?? ''}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <label className="field">
            <span>These words are in</span>
            <select
              value={sourceLang}
              onChange={(e) => setSourceLang(e.target.value as Lang)}
            >
              {[settings.nativeLang, ...settings.targetLangs].map((l) => (
                <option key={l} value={l}>
                  {LANG_NAMES[l]}
                </option>
              ))}
            </select>
          </label>

          <div className="row">
            <button
              className="primary"
              disabled={busy || lines.length === 0}
              onClick={() => void run()}
            >
              {busy ? 'Importing…' : `Import ${lines.length} words`}
            </button>
            <button className="link" onClick={() => setRows(null)} disabled={busy}>
              Cancel
            </button>
          </div>
        </>
      )}

      {status && <div className="status ok">{status}</div>}

      <h3>Take yours out</h3>
      <p className="muted small">
        One row per word per language, readable by a spreadsheet and by Anki.
        Worth doing before clearing site data or changing browser — you own
        these words, and being able to leave is part of that.
      </p>
      <div className="row">
        <button onClick={() => void exportCsv()}>Export CSV</button>
      </div>
    </div>
  )
}

async function exportCsv() {
  const [concepts, entries] = await Promise.all([
    db.concepts.toArray(),
    db.entries.toArray(),
  ])
  const byConcept = new Map<string, typeof entries>()
  for (const e of entries) {
    const list = byConcept.get(e.conceptId) ?? []
    list.push(e)
    byConcept.set(e.conceptId, list)
  }

  const rows: (string | undefined)[][] = [
    ['lemma', 'language', 'headword', 'meaning', 'example', 'gloss', 'pos', 'topics'],
  ]
  for (const c of concepts) {
    if (c.deletedAt) continue
    for (const e of byConcept.get(c.id) ?? []) {
      rows.push([
        c.lemma,
        e.lang,
        e.headword,
        e.meaning,
        e.example,
        e.exampleGloss,
        c.pos,
        (c.tags ?? []).join('; '),
      ])
    }
  }
  downloadCsv(`lingu3-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows))
}
