/**
 * A small CSV/TSV reader and writer.
 *
 * This exists instead of Anki .apkg import, which was evaluated and rejected.
 * An .apkg is a zip around a SQLite database, and since Anki 2.1.50 the real
 * database inside is `collection.anki21b`, compressed with zstd — the
 * `collection.anki2` beside it is a decoy holding a single "update your Anki"
 * row. Reading it in a browser means an unzip library, a megabyte of SQLite
 * wasm and a zstd decoder.
 *
 * And the file format is the easy half. Anki notes are freeform fields joined
 * by 0x1f under note types the user defined themselves, so nothing in the file
 * says which field is the headword, which is the meaning, or where the gender
 * is. Scheduling history does not transfer either: SM-2 ease does not map onto
 * FSRS stability and difficulty.
 *
 * Anki exports Notes in Plain Text natively, so a column mapper over CSV
 * covers the Anki case — and Quizlet, Memrise, a spreadsheet and a word list
 * typed in class, which .apkg parsing would not have.
 */

/** Quotes, embedded commas, embedded newlines, doubled quotes to escape one. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = 0

  // A byte-order mark at the start of a file Excel wrote would otherwise
  // become part of the first header name.
  if (text.charCodeAt(0) === 0xfeff) i = 1

  while (i < text.length) {
    const ch = text[i]

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }

    if (ch === '"' && field === '') {
      quoted = true
      i++
      continue
    }
    if (ch === delimiter) {
      row.push(field)
      field = ''
      i++
      continue
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      field = ''
      if (row.some((f) => f.trim() !== '')) rows.push(row)
      row = []
      i++
      continue
    }
    field += ch
    i++
  }

  row.push(field)
  if (row.some((f) => f.trim() !== '')) rows.push(row)
  return rows.map((r) => r.map((f) => f.trim()))
}

/**
 * Guesses the separator by counting candidates on the first few lines. Tabs
 * first: Anki's plain-text export is tab-separated, and a tab inside a field
 * is rare enough to be worth trusting over a comma.
 */
export function sniffDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).slice(0, 5).join('\n')
  const counts = [
    ['\t', (sample.match(/\t/g) ?? []).length],
    [',', (sample.match(/,/g) ?? []).length],
    [';', (sample.match(/;/g) ?? []).length],
  ] as const
  const best = [...counts].sort((a, b) => b[1] - a[1])[0]
  return best[1] > 0 ? best[0] : ','
}

/**
 * Does the first row look like headers rather than data?
 *
 * The test is whether it contains words that name a column rather than a word
 * to learn. Getting this wrong only costs one row either way, and it is
 * switchable in the UI.
 */
export function looksLikeHeader(row: string[]): boolean {
  const known = [
    'word', 'words', 'term', 'headword', 'lemma', 'front', 'back',
    'meaning', 'translation', 'definition', 'hint', 'sense', 'note', 'notes',
    'topic', 'topics', 'tag', 'tags', 'category', 'deck', 'lang', 'language',
  ]
  const hits = row.filter((c) => known.includes(c.toLocaleLowerCase())).length
  return hits >= Math.max(1, Math.ceil(row.length / 3))
}

export function toCsv(rows: (string | number | undefined)[][]): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const value = cell === undefined || cell === null ? '' : String(cell)
          return /[",\n\r]/.test(value)
            ? `"${value.replace(/"/g, '""')}"`
            : value
        })
        .join(','),
    )
    .join('\r\n')
}

/** Triggers a download. Excel needs the BOM to read UTF-8 without mangling it. */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
