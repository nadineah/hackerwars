import { useEffect, useRef, useState } from 'react';
import type { Design } from '../shared/types';
import { ChevronIcon } from './Icons';

/**
 * The File button in the top bar: the design ("file") this page is working on, the same one in the chat and in Edit
 * Mode. Its menu renames it, turns it off or on here, starts a new one, or opens another from the Library.
 */
export function FileMenu({
  file,
  on,
  disabled,
  onNew,
  onRename,
  onToggle,
  onClearChat,
  onUndoClearChat,
  onCopy,
  onOpen,
  recent,
  onOpenRecent,
}: {
  file: Design | null;
  /** Whether the file shows on this page now. */
  on: boolean;
  disabled?: boolean;
  onNew: () => void;
  onRename: (name: string) => void;
  onToggle: () => void;
  onClearChat: () => void;
  /** Set while the last Clear chat can still be undone. */
  onUndoClearChat?: () => void;
  onCopy: () => void;
  onOpen: () => void;
  /** Designs for this site used lately (not the current one), newest first. */
  recent: Design[];
  onOpenRecent: (d: Design) => void;
}) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  /** Open recent's own list (in place of the menu, with Back). */
  const [showRecent, setShowRecent] = useState(false);
  const [draft, setDraft] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) {
      setRenaming(false);
      setShowRecent(false);
      return;
    }
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    root.current?.querySelector<HTMLElement>('.file-pop [role="menuitem"]:not([disabled])')?.focus();
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // keyboard: going into Open recent (or back) puts focus on its first row
  useEffect(() => {
    if (open) root.current?.querySelector<HTMLElement>('.file-pop [role="menuitem"]:not([disabled])')?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showRecent]);

  const close = () => {
    setOpen(false);
    btn.current?.focus();
  };
  const pick = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  const saveName = () => {
    const n = draft.trim();
    if (n && file && n !== file.name) onRename(n.slice(0, 60));
    setRenaming(false);
  };

  return (
    <div className="file-wrap" ref={root} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), renaming ? setRenaming(false) : showRecent ? setShowRecent(false) : close())}>
      <button ref={btn} className={on || !file ? 'file-btn' : 'file-btn off'} disabled={disabled} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} title="The design this page is working on: the chat and Edit Mode both change it">
        <span className="file-kicker">File</span>
        <span className="file-name">{file ? file.name : 'None yet'}</span>
        {file && !on && <span className="file-off">off</span>}
        <span className="file-chev" aria-hidden="true">
          <ChevronIcon size={14} />
        </span>
      </button>
      {open && (
        <div className="file-pop" role="menu" aria-label="File">
          {/* the full name (the button may have to cut it short) */}
          {showRecent ? <div className="file-title">Open recent</div> : file && !renaming && <div className="file-title">{file.name}</div>}
          {showRecent ? (
            <>
              <button role="menuitem" className="menu-item file-back" onClick={() => setShowRecent(false)}>
                ‹ Back
              </button>
              <div className="file-sep" role="separator" />
              {recent.map((d) => (
                <button key={d.id} role="menuitem" className="menu-item file-recent" onClick={pick(() => onOpenRecent(d))} title={`Switch “${d.name}” on here and open its chat`}>
                  {d.name}
                </button>
              ))}
            </>
          ) : renaming && file ? (
            <input
              className="file-rename"
              autoFocus
              value={draft}
              maxLength={60}
              aria-label={`New name for ${file.name}`}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveName();
              }}
              onBlur={saveName}
            />
          ) : (
            <>
              <button role="menuitem" className="menu-item" onClick={pick(onNew)} title="An empty design for this site, called “My design” until it has a name. The one that is on now stays in the Library.">
                New design
              </button>
              {recent.length > 0 && (
                <button role="menuitem" className="menu-item file-more" aria-haspopup="menu" onClick={() => setShowRecent(true)}>
                  <span>Open recent</span>
                  <span className="file-more-chev" aria-hidden="true">
                    <ChevronIcon size={15} />
                  </span>
                </button>
              )}
              <button role="menuitem" className="menu-item" onClick={pick(onOpen)}>
                Open another design… <span className="hint">Library</span>
              </button>
              {file && (
                <>
                  <div className="file-sep" role="separator" />
                  <button role="menuitem" className="menu-item" onClick={() => (setDraft(file.name), setRenaming(true))}>
                    Rename…
                  </button>
                  <button role="menuitem" className="menu-item" onClick={pick(onCopy)} title={`A copy of “${file.name}” with its chat, to change on its own; the original stays in the Library`}>
                    Make a copy
                  </button>
                  <button role="menuitem" className="menu-item" onClick={pick(onToggle)}>
                    {on ? 'Turn off here' : 'Turn on here'}
                  </button>
                  <div className="file-item-row">
                    <button role="menuitem" className="menu-item" onClick={pick(onClearChat)} title="Start this design’s chat over. The design stays exactly as it is.">
                      Clear chat
                    </button>
                    {onUndoClearChat && (
                      <button role="menuitem" className="file-undo" onClick={pick(onUndoClearChat)} title="Bring the cleared chat back as it was">
                        Undo
                      </button>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
