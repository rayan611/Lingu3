import { useState } from 'react'
import { normaliseTags } from '../ai/expand'

/**
 * Topic tags, editable.
 *
 * Multi-valued on purpose: a word is routinely more than one thing —
 * `beställa` is restaurant and work — and a single-category field would have
 * to pick one and be wrong half the time. Free text so a topic that is not on
 * anyone's list still works.
 *
 * Used both before saving, where it edits a draft, and on the saved word card,
 * where it writes through. Same component either way, so the two cannot drift.
 */
export function TagEditor({
  tags,
  onChange,
  suggestions = [],
  disabled,
  label = 'Topics',
}: {
  tags: string[]
  onChange: (next: string[]) => void
  suggestions?: string[]
  disabled?: boolean
  label?: string
}) {
  const [draft, setDraft] = useState('')

  function add(raw: string) {
    const next = normaliseTags([...tags, raw])
    if (next.length !== tags.length) onChange(next)
    setDraft('')
  }

  const unused = suggestions.filter((s) => !tags.includes(s)).slice(0, 6)

  return (
    <div className="tag-editor">
      <span className="muted small">{label}</span>
      <div className="tag-row">
        {tags.map((t) => (
          <span key={t} className="tag">
            {t}
            {!disabled && (
              <button
                className="tag-remove"
                aria-label={`Remove ${t}`}
                onClick={() => onChange(tags.filter((x) => x !== t))}
              >
                ×
              </button>
            )}
          </span>
        ))}
        {tags.length === 0 && <span className="muted small">none yet</span>}
      </div>

      {!disabled && (
        <>
          <form
            className="tag-add"
            onSubmit={(e) => {
              e.preventDefault()
              if (draft.trim()) add(draft)
            }}
          >
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Add a topic"
              maxLength={24}
              disabled={tags.length >= 4}
            />
            <button type="submit" disabled={!draft.trim() || tags.length >= 4}>
              add
            </button>
          </form>
          {unused.length > 0 && (
            <div className="tag-row">
              {unused.map((s) => (
                <button key={s} className="chip" onClick={() => add(s)}>
                  + {s}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
