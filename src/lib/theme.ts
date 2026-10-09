/**
 * Theme choice.
 *
 * Device-local, not synced — the same reasoning as typed recall. Which theme
 * suits you is a property of the screen you are looking at and the light in
 * the room, not of your account, and carrying it between a phone and a laptop
 * would be a small, steady annoyance rather than a feature.
 *
 * Stored in localStorage and applied as `data-theme` on <html>, which the
 * stylesheet already keys off: the dark palette is written as
 * `:root:not([data-theme='light'])` under a prefers-color-scheme query, so
 * "system" is simply the absence of an explicit choice.
 */
export const THEMES = ['system', 'light', 'dark', 'dark-blue'] as const
export type Theme = (typeof THEMES)[number]

export const THEME_LABELS: Record<Theme, string> = {
  system: 'Match my device',
  light: 'Light',
  dark: 'Dark',
  'dark-blue': 'Dark blue',
}

const KEY = 'lingua.theme'

export function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(KEY)
    if (stored && (THEMES as readonly string[]).includes(stored)) {
      return stored as Theme
    }
  } catch {
    /* private mode, or storage blocked — fall through to the default */
  }
  return 'system'
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)

  // Keep the browser chrome in step with the page, or a dark app sits under a
  // light status bar on Android.
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) {
    const dark =
      theme === 'dark' ||
      theme === 'dark-blue' ||
      (theme === 'system' &&
        window.matchMedia?.('(prefers-color-scheme: dark)').matches)
    meta.setAttribute('content', dark ? '#171c22' : '#f7f5f0')
  }
}

export function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    /* the choice just does not survive a reload; the app still works */
  }
  applyTheme(theme)
}
