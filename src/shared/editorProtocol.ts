import type { EditTarget, Origin, VisualEdit } from './edits';

/** Messages between the side panel's editor and the page, over one port named `ww-editor` (closing it ends Edit Mode). */

export type Kind = 'image' | 'video' | 'link' | 'button' | 'field' | 'heading' | 'text' | 'list' | 'section' | 'decoration' | 'box' | 'page';

export interface TreeNode {
  /** Page-session id; a design decoration is `<id>::before` / `<id>::after`. */
  id: string;
  kind: Kind;
  label: string;
  detail: string;
  origin: Origin;
  hasChildren: boolean;
  hidden?: boolean;
  edited?: boolean;
}

export interface SelectionInfo {
  id: string;
  kind: Kind;
  label: string;
  tag: string;
  origin: Origin;
  pseudo?: '::before' | '::after';
  /** How to find it again; the edit's own target when it already has one. */
  target: EditTarget;
  /** The edit (in the design being edited) that styles it, if any. */
  editId?: string;
  editCss: Record<string, string>;
  editText?: string;
  /** "This and the others like it" is on for its edit. */
  editAll?: string;
  computed: Record<string, string>;
  box: { w: number; h: number };
  html: string;
  /** The applied designs' rules for it (read-only). */
  themeRules: string[];
  /** Its text when it is a plain text element (editable), else null. */
  text: string | null;
  caps: { resize: boolean; move: boolean; text: boolean; image: boolean; hide: boolean };
  similar: { selector: string; count: number } | null;
  /** Up to three ancestors, nearest first ("Card · 300x200"), for the AI. */
  parents: string[];
}

export type ToPage =
  | { t: 'start'; designId: string; edits: VisualEdit[] }
  | { t: 'retarget'; designId: string }
  | { t: 'stop' }
  | { t: 'select'; id: string }
  | { t: 'clear' }
  | { t: 'children'; id: string }
  | { t: 'expanded'; ids: string[] }
  /** The saved state of the edits (after undo, redo, Options, Code, AI): applied and kept. */
  | { t: 'setEdits'; edits: VisualEdit[] }
  /** A live preview while a slider or colour is being dragged; not kept. */
  | { t: 'preview'; edits: VisualEdit[] };

export type FromPage =
  | { t: 'ready' }
  | { t: 'selected'; info: SelectionInfo; path: string[] }
  | { t: 'info'; info: SelectionInfo }
  | { t: 'cleared' }
  | { t: 'gone' }
  | { t: 'children'; id: string; nodes: TreeNode[]; more: number }
  | { t: 'treeChanged'; ids: string[] }
  /** A change made on the page (toolbar, drag, resize, keys): becomes one undo step. */
  | { t: 'commit'; edits: VisualEdit[]; label: string }
  | { t: 'undo' }
  | { t: 'redo' }
  | { t: 'openOptions' }
  /** Something the person should know (an element that cannot be edited reliably). */
  | { t: 'notice'; text: string };
