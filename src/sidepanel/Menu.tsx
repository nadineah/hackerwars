import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { MoreIcon } from './Icons';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  /** Greyed out and not selectable. */
  disabled?: boolean;
  /** A thin divider is drawn above this item. */
  separator?: boolean;
  /** Why it is greyed out, shown under the label while disabled. */
  hint?: string;
}

/**
 * The ⋮ menu on a row. Keyboard friendly: Enter/Space/ArrowDown opens it, arrows move, Home/End jump, Escape closes and
 * returns focus to the button. A click outside closes it.
 */
export function RowMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    root.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const move = (dir: 1 | -1 | 'first' | 'last') => {
    const els = [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])];
    if (!els.length) return;
    const i = els.indexOf(document.activeElement as HTMLElement);
    const next = dir === 'first' ? 0 : dir === 'last' ? els.length - 1 : (i + dir + els.length) % els.length;
    els[next].focus();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
      btn.current?.focus();
    } else if (e.key === 'ArrowDown') (e.preventDefault(), move(1));
    else if (e.key === 'ArrowUp') (e.preventDefault(), move(-1));
    else if (e.key === 'Home') (e.preventDefault(), move('first'));
    else if (e.key === 'End') (e.preventDefault(), move('last'));
    else if (e.key === 'Tab') setOpen(false);
  };

  return (
    <div className="menu-wrap" ref={root} onKeyDown={onKey}>
      <button
        ref={btn}
        className="more-btn"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <MoreIcon size={18} />
      </button>
      {open && (
        <div className="menu" role="menu" id={id} aria-label={label}>
          {items.map((it) => (
            <MenuButton key={it.label} item={it} close={() => setOpen(false)} />
          ))}
        </div>
      )}
    </div>
  );
}

function MenuButton({ item, close }: { item: MenuItem; close: () => void }): ReactNode {
  return (
    <>
      {item.separator && <div className="menu-sep" role="separator" />}
      <button
        role="menuitem"
        className={item.danger ? 'menu-item danger' : 'menu-item'}
        disabled={item.disabled}
        onClick={() => {
          close();
          item.onSelect();
        }}
      >
        {item.label}
        {item.disabled && item.hint && <span className="menu-hint">{item.hint}</span>}
      </button>
    </>
  );
}
