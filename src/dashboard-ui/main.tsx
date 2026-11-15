import { Component, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { useSnapshot } from './data';
import { Editor } from './Editor';
import { Library } from './Library';
import './dashboard.css';

/** Hash routes keep this one extension page a single entry: #/ is the library, #/d/<id> is the editor. */
const route = () => /^#\/d\/([A-Za-z0-9_-]{4,40})$/.exec(location.hash)?.[1] ?? null;

/** A render error must never blank the whole page: show what happened and a way back. */
class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="pad" role="alert">
        <h2>Something went wrong showing this page</h2>
        <p className="error">{this.state.error.message}</p>
        <button onClick={() => (location.hash = '#/', this.setState({ error: null }))}>Back to all dashboards</button>{' '}
        <button onClick={() => location.reload()}>Reload</button>
      </div>
    );
  }
}

export function App() {
  const snap = useSnapshot();
  const [id, setId] = useState<string | null>(route);
  useEffect(() => {
    const on = () => setId(route());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  useEffect(() => {
    document.title = id ? `${snap.dashboards.find((d) => d.id === id)?.name ?? 'Dashboard'} · WhimsyWeb` : 'Dashboards · WhimsyWeb';
  }, [id, snap.dashboards]);
  const open = (next: string | null) => {
    location.hash = next ? `#/d/${next}` : '#/';
  };
  return (
    <div className="shell">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <div id="main">
        <Boundary key={id ?? 'lib'}>{id ? <Editor key={id} id={id} snap={snap} back={() => open(null)} /> : <Library snap={snap} open={open} />}</Boundary>
      </div>
    </div>
  );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
