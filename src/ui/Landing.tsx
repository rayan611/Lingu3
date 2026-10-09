import { Logo } from './Logo'

const SEEN_KEY = 'lingua.landingSeen'

/**
 * Has this visitor already been past the front door?
 *
 * Three ways to be past it, and all three skip the landing:
 *
 *  - the app is installed and launched from the home screen, where a
 *    marketing page between the icon and the words would be absurd;
 *  - they have opened it before on this device;
 *  - they are signed in, which is checked by the caller.
 *
 * The flag is device-local on purpose. It is a fact about this browser, not
 * about the account, so it has no business in the synced settings row.
 */
export function shouldShowLanding(): boolean {
  if (typeof window === 'undefined') return false
  const standalone =
    window.matchMedia?.('(display-mode: standalone)').matches ||
    // iOS Safari does not implement display-mode and uses this instead.
    (navigator as { standalone?: boolean }).standalone === true
  if (standalone) return false
  try {
    return window.localStorage.getItem(SEEN_KEY) !== '1'
  } catch {
    // Private mode, or storage blocked. Showing the page once per visit is a
    // better failure than throwing on the way to the app.
    return true
  }
}

export function Landing({ onOpen }: { onOpen: () => void }) {
  function open() {
    try {
      window.localStorage.setItem(SEEN_KEY, '1')
    } catch {
      /* not worth failing the click over */
    }
    onOpen()
  }

  return (
    <div className="landing">
      <div className="landing-mark">
        <Logo size={64} />
      </div>
      <h1>Lingu3</h1>
      <p className="landing-pitch">
        Learn up to three languages at once from your own words — the ones you
        actually met today, not a stock list.
      </p>
      <p className="landing-pitch">
        Each language is scheduled separately, so the one you find hard comes
        back sooner and the one you know stays out of your way. It works
        offline.
      </p>
      <button className="primary big" onClick={open}>
        Open app
      </button>
      <p className="muted small landing-note">
        Free. Your words are stored on your device and synced to your account.
      </p>
    </div>
  )
}
