import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
  info: string
}

/**
 * Catches render-time errors and shows them. Without this, one bad row in the
 * database blanks the whole app and the only clue is an empty screen — which
 * is the hardest kind of bug to report and the hardest to fix remotely.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: '' }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ info: info.componentStack ?? '' })
    console.error('Lingua crashed:', error, info)
  }

  async reset() {
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations()
        await Promise.all(regs.map((r) => r.unregister()))
      }
      if (window.caches) {
        const keys = await caches.keys()
        await Promise.all(keys.map((k) => caches.delete(k)))
      }
    } catch {
      /* best effort */
    }
    location.replace(`${location.pathname}?reset=${Date.now()}`)
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <div className="app">
        <div className="panel" style={{ marginTop: 32 }}>
          <h2>Something broke</h2>
          <p className="muted small">
            Your words are safe — they're stored separately from the screen that
            failed. Copy the error below and send it to Claude.
          </p>
          <pre className="crash-detail">
            {this.state.error.message}
            {'\n'}
            {this.state.error.stack ?? ''}
            {this.state.info}
          </pre>
          <div className="row">
            <button className="primary" onClick={() => location.reload()}>
              Reload
            </button>
            <button onClick={() => void this.reset()}>
              Clear cache and reload
            </button>
          </div>
        </div>
      </div>
    )
  }
}
