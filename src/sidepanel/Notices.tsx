import { useEffect, useState } from 'react';
import { Favicon } from './Library';

/**
 * Small notices about work on OTHER tabs (docs/spec-chat-follows-tab.md, section 5). They sit in the corner under
 * the top bar, never take focus, and never switch tabs on their own: only "Go to tab" does.
 *  done: fades after a few seconds (not while hovered or opened). needs / problem: stay until dealt with.
 */
export interface Notice {
  id: string;
  kind: 'done' | 'needs' | 'problem';
  host: string;
  path: string;
  tabId: number;
  /** The job, for "Skip review". */
  requestId?: string;
  /** The chat the notice is about (shown on its tab after "Go to tab"). */
  convoId?: string | null;
  title: string;
  /** The full text, shown when the notice is opened. */
  detail: string;
}

export const DONE_FADE_MS = 6000;
/** From this many notices on, they fold into one "N updates" pill. */
const FOLD_AT = 3;

interface Props {
  notices: Notice[];
  favicons: Record<string, string>;
  onGo: (n: Notice) => void;
  onSkip: (n: Notice) => void;
  onDismiss: (id: string) => void;
}

export function Notices({ notices, favicons, onGo, onSkip, onDismiss }: Props) {
  const [unfolded, setUnfolded] = useState(false);
  useEffect(() => {
    if (notices.length < FOLD_AT) setUnfolded(false);
  }, [notices.length]);
  const folded = notices.length >= FOLD_AT && !unfolded;
  return (
    <div className="notices" role="status" aria-live="polite">
      {folded ? (
        <button className="notice notice-fold" onClick={() => setUnfolded(true)} aria-expanded={false}>
          <span className={`notice-dot ${notices.some((n) => n.kind !== 'done') ? 'needs' : 'done'}`} aria-hidden="true" />
          <span className="notice-title">{notices.length} updates</span>
        </button>
      ) : (
        notices.map((n) => <NoticeItem key={n.id} n={n} favicons={favicons} onGo={onGo} onSkip={onSkip} onDismiss={onDismiss} />)
      )}
      {notices.length >= FOLD_AT && unfolded && (
        <button className="notice-collapse" onClick={() => setUnfolded(false)}>
          Fold up
        </button>
      )}
    </div>
  );
}

function NoticeItem({ n, favicons, onGo, onSkip, onDismiss }: { n: Notice; favicons: Record<string, string> } & Omit<Props, 'notices' | 'favicons'>) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  // "Done" fades on its own unless you are reading it.
  useEffect(() => {
    if (n.kind !== 'done' || open || hover) return;
    const t = window.setTimeout(() => onDismiss(n.id), DONE_FADE_MS);
    return () => window.clearTimeout(t);
  }, [n.kind, n.id, open, hover, onDismiss]);
  return (
    <div
      className={`notice ${n.kind}${open ? ' open' : ''}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
    >
      <div className="notice-head">
        <button className="notice-main" onClick={() => setOpen((o) => !o)} aria-expanded={open} title={open ? 'Hide details' : 'Show details'}>
          <span className={`notice-dot ${n.kind}`} aria-hidden="true" />
          <Favicon host={n.host} favicons={favicons} />
          <span className="notice-title">{n.title}</span>
        </button>
        <button className="notice-x" onClick={() => onDismiss(n.id)} aria-label="Dismiss" title="Dismiss">
          ✕
        </button>
      </div>
      {open && n.detail && <p className="notice-detail">{n.detail}</p>}
      {(open || n.kind === 'needs') && (
        <div className="notice-actions">
          <button className="notice-btn" onClick={() => onGo(n)}>Go to tab</button>
          {n.kind === 'needs' && (
            <button className="notice-btn quiet" onClick={() => onSkip(n)}>
              Skip review
            </button>
          )}
        </div>
      )}
    </div>
  );
}
