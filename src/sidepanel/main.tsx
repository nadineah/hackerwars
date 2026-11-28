import { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { applyTheme, cachedTheme } from './theme';

applyTheme(cachedTheme());

/** A bug while drawing the panel shows what went wrong and a way back, instead of an empty panel. */
class Crash extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error('Whimsy Web panel error', error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="app crash" role="alert">
        <h2>Something went wrong in this panel</h2>
        <p className="hint">Your designs and edits are saved. Reopen the panel to carry on.</p>
        <pre className="crash-detail">{String(this.state.error.message || this.state.error)}</pre>
        <button className="primary" onClick={() => location.reload()}>
          Reopen the panel
        </button>
      </div>
    );
  }
}

createRoot(document.getElementById('root')!).render(
  <Crash>
    <App />
  </Crash>,
);
