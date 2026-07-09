import { Component, type ReactNode } from 'react'

// A crash in any widget body used to throw straight through React and unmount
// the whole canvas — one bad diff/panel took down the entire app. This boundary
// contains the failure to the single widget, showing an inline error with a
// retry instead of white-screening everything.

type Props = { children: ReactNode }
type State = { error: Error | null }

export class WidgetErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error) {
    // surface it for debugging without killing the app
    console.error('widget crashed:', error)
  }

  render() {
    const { error } = this.state
    if (error) {
      return (
        <div className="widget__crash">
          <div className="widget__crash-title">This widget hit an error</div>
          <div className="widget__crash-msg">{error.message || String(error)}</div>
          <button className="widget__crash-retry" onClick={() => this.setState({ error: null })}>
            Retry
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
