import { useState } from 'react'
import { saveSettings } from '../db/db'

/**
 * Asked once, the first time you are signed in without a name set.
 *
 * Dismissible, because being made to fill in a field before you can use the
 * app you just signed into is a bad trade for a greeting. It is editable later
 * in Settings either way.
 */
export function NamePrompt() {
  const [name, setName] = useState('')
  const [hidden, setHidden] = useState(false)
  if (hidden) return null

  return (
    <form
      className="panel"
      onSubmit={(e) => {
        e.preventDefault()
        const trimmed = name.trim().slice(0, 40)
        if (trimmed) void saveSettings({ displayName: trimmed })
        setHidden(true)
      }}
    >
      <h3>What should I call you?</h3>
      <p className="muted small">
        Only used to say hello at the top of the screen. You can change it in
        Settings.
      </p>
      <div className="row">
        <input
          className="field-grow"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          maxLength={40}
          autoFocus
        />
        <button className="primary" type="submit" disabled={!name.trim()}>
          Save
        </button>
        <button type="button" className="link" onClick={() => setHidden(true)}>
          Not now
        </button>
      </div>
    </form>
  )
}
