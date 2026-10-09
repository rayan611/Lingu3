import { useEffect, useState } from 'react'

/**
 * Offer to install the app, in the two different ways the two platforms need.
 *
 * Chrome and the Android browsers fire `beforeinstallprompt`, which can be
 * stashed and replayed on a click. iOS Safari never fires it and has no API at
 * all — there, installing is Share → Add to Home Screen, and the only thing
 * that helps is saying so.
 *
 * Either way the button disappears once the app is already installed, which is
 * what `display-mode: standalone` tells us. Without that check it would nag
 * forever on the one device where it is least useful.
 */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const DISMISSED = 'lingua.installHintDismissed'

export function InstallButton() {
  const [deferred, setDeferred] = useState<InstallPromptEvent | null>(null)
  const [showIosHint, setShowIosHint] = useState(false)
  const [installed, setInstalled] = useState(false)

  useEffect(() => {
    const standalone =
      window.matchMedia?.('(display-mode: standalone)').matches ||
      // Safari's own flag, which predates the media query.
      (navigator as { standalone?: boolean }).standalone === true
    if (standalone) {
      setInstalled(true)
      return
    }

    const onPrompt = (e: Event) => {
      e.preventDefault()
      setDeferred(e as InstallPromptEvent)
    }
    const onInstalled = () => setInstalled(true)
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  if (installed) return null

  const isIos =
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    // iPadOS reports itself as a Mac, but a Mac has no touch points.
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

  let dismissed = false
  try {
    dismissed = localStorage.getItem(DISMISSED) === '1'
  } catch {
    /* storage blocked — show it */
  }

  if (deferred) {
    return (
      <button
        className="install-button"
        onClick={() => {
          void deferred.prompt().then(() => setDeferred(null))
        }}
      >
        Install
      </button>
    )
  }

  if (isIos && !dismissed) {
    return (
      <>
        <button className="install-button" onClick={() => setShowIosHint(true)}>
          Install
        </button>
        {showIosHint && (
          <div className="panel install-hint">
            <p className="small">
              On iPhone and iPad this is a Safari thing rather than something
              the page can do: tap the <strong>Share</strong> button, then{' '}
              <strong>Add to Home Screen</strong>. It then opens full screen and
              works offline.
            </p>
            <div className="row">
              <button onClick={() => setShowIosHint(false)}>Got it</button>
              <button
                className="link"
                onClick={() => {
                  try {
                    localStorage.setItem(DISMISSED, '1')
                  } catch {
                    /* nothing to do */
                  }
                  setShowIosHint(false)
                }}
              >
                Don't show this again
              </button>
            </div>
          </div>
        )}
      </>
    )
  }

  return null
}
