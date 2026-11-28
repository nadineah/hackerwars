import type { EditBase, EditTarget, InsertKind, InsertPosition, Origin, Slot, VisualEdit } from './edits';
import type { AiContextKind } from './types';

export type EditState = 'normal' | 'hover' | 'focus';

export type MoveMode = 'layout' | 'free';
export type MoveStep = 'earlier' | 'later' | 'out' | 'in';

/**
 * A part of the selected element with options of its own (the icon in a button, the overlay that darkens it on hover).
 * Changes to it are written to its own edit (`base`), next to the element's.
 */
export interface PartInfo {
  role: 'icon' | 'overlay';
  /** Its tree id (to select it on its own). */
  id: string;
  label: string;
  base: EditBase;
  editCss: Record<string, string>;
  editSlots: Partial<Record<Slot, Record<string, string>>>;
  computed: Record<string, string>;
  /** Icons: drawn by an SVG, a font glyph, or a small picture. */
  iconType?: 'svg' | 'font' | 'img';
  /** SVG icons: which properties make its colour follow `color` (on the svg itself, and on its shapes). */
  paint?: { root: string[]; shapes: string[] };
  /** SVG icons: its shape as a picture, to use as a mask so a gradient can colour it (absent: it cannot be made one). */
  svgMask?: string;
  /** Overlays: the element around it, whose own background is its hover look (not a layer over it). */
  around?: boolean;
  /** Overlays hidden right now: how the site shows it (from its own rules for hover, pressed, focused). */
  stateLook?: { opacity?: number; color?: string };
  /** Overlays: the pointer was over its element when measured, so the site's hover look may be what `computed` shows. */
  hovered?: boolean;
}

/** Messages between the side panel's editor and the page, over one port named `ww-editor` (closing it ends Edit Mode). */

/**
 * Which elements Edit Mode lists and picks: Smart (what you see plus the cards, rows and sections it sits in, one per
 * box), Drawn only (only what draws something itself), Everything (every element, as the page is built).
 */
export type ElementView = 'smart' | 'visual' | 'all';

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
  /** Hidden by a change made here (the tree's eye shows it again); otherwise the site hides it. */
  hiddenByYou?: boolean;
  edited?: boolean;
  /** Visual elements: a layout element (draws nothing itself) shown only while it is selected, e.g. by Select parent. */
  layout?: boolean;
  /**
   * What its background is, shown as a small swatch: a colour (or gradient), a picture, or a video; none of its own:
   * a picture or video inside it (a card), else transparent.
   */
  bg?: { color?: string; image?: true; video?: true; inner?: 'image' | 'video'; transparent?: true; text?: string; through?: string };
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
  /** Its hover / focus looks and the other style sets of its edit. */
  editSlots: Partial<Record<Slot, Record<string, string>>>;
  /** The looks it can have besides normal (hover for things people point at, focus for controls and fields). */
  states: Exclude<EditState, 'normal'>[];
  /** Its icon and hover overlay, when it has them (single selection only). */
  parts: { icon?: PartInfo; overlay?: PartInfo };
  /** It shows words besides its icon (false: an icon, or a button or link with only an icon). Absent: not known. */
  words?: boolean;
  move: {
    mode: MoveMode;
    /** It can be moved in the layout (one element, not the page, not a decoration). */
    canLayout: boolean;
    /** It has been moved in the layout. */
    moved: boolean;
    /** How the element it is in lays out its children. */
    parent: 'flow' | 'row' | 'column' | 'grid';
    /** The site kept putting it back, so the move is not shown on this page view. */
    gaveUp?: boolean;
  };
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
  caps: { resize: boolean; move: boolean; text: boolean; image: boolean; hide: boolean; add: boolean };
  /** It was added by hand in Edit Mode (Delete removes it). */
  added?: boolean;
  similar: { selector: string; count: number } | null;
  /** Up to three ancestors, nearest first ("Card · 300x200"), for the AI. */
  parents: string[];
  /** What it sits in, as the current view lists it (outermost first, the page left out): a breadcrumb. */
  crumbs?: { id: string; label: string }[];
  /** How wide its words are (px), when they are narrower than its box: a text gradient is fitted to them. */
  textWidth?: number;
  /** It turned out to show only while pointed at (stays set for this selection, also while it is shown again). */
  showsOnHover?: boolean;
  /** It is one of several items alike (a card in a feed, a row of a list): the actions people use on those first. */
  repeated?: number;
  /** More than one element is selected: a change applies to every one (one edit per base). */
  multi?: {
    count: number;
    /** "Select similar" is on: one edit for every element matching this selector (also ones that load later). */
    group?: string;
    /** Every selected element's tree id, for highlighting. */
    ids: string[];
    /** What each change is written to. */
    bases: EditBase[];
  };
}

export type ToPage =
  /** view: which elements the tree and page clicks show (default Smart). */
  | { t: 'start'; designId: string; edits: VisualEdit[]; view?: ElementView }
  /** Switch the view (the page answers with the selection's new tree path). */
  | { t: 'mode'; view: ElementView }
  | { t: 'retarget'; designId: string }
  | { t: 'stop' }
  /** add: Ctrl/Shift-click in the tree adds (or removes) it instead of selecting only it. */
  | { t: 'select'; id: string; add?: boolean }
  /** Select every element like the selected one. */
  | { t: 'selectSimilar' }
  /** Back to just the main selected element. */
  | { t: 'selectOnly' }
  /** The tree's eye: hide that element, or show it again (one it was hidden by here), without selecting it. */
  | { t: 'toggleHidden'; id: string }
  | { t: 'clear' }
  /** The selected element is only shown on hover and has gone: select what is on the page where it was. */
  | { t: 'selectUnder' }
  /** Show the selection as if pointed at when it only shows on hover (on by default): the page fakes the hover. */
  | { t: 'fakeHover'; on: boolean }
  /** The looks the page shows for the selection, for as long as it is selected (the panel's Hover and Focus boxes). */
  | { t: 'looks'; hover: boolean; focus: boolean }
  /** Modify with Claude: more of the page around the selection, described for the model, with what each ref changes. */
  | { t: 'aiContext'; want: AiContextKind[] }
  /** Deletes the selection: an element added by hand is removed, a site element is taken out of the layout. */
  | { t: 'delete' }
  /** Adds an element before, after or inside the selected one (css: e.g. its picture). */
  /** text: the new element's words (else its kind's placeholder). */
  | { t: 'add'; kind: InsertKind; position: InsertPosition; css?: Record<string, string>; text?: string }
  /** A level of the tree: the loaded range of a long list (start/end; none: the first batch), and a child that must be in it. */
  | { t: 'children'; id: string; start?: number; end?: number; reveal?: string }
  | { t: 'expanded'; ids: string[] }
  /** The saved state of the edits (after undo, redo, Options, Code, AI): applied and kept. */
  | { t: 'setEdits'; edits: VisualEdit[] }
  /** A live preview while a slider or colour is being dragged; not kept. */
  | { t: 'preview'; edits: VisualEdit[] }
  /** Show the selection's hover or focus look on the page (while that tab is open in the panel). */
  | { t: 'state'; state: EditState }
  /** How dragging moves the selection: within the layout, or freely (a visual offset). */
  | { t: 'moveMode'; mode: MoveMode }
  /** Moves the selection one step in the layout: before the previous / after the next element, out of its box, into the box before it. */
  | { t: 'moveStep'; dir: MoveStep }
  /** Puts a moved element back where it was. */
  | { t: 'unmove' };

export type FromPage =
  | { t: 'ready' }
  | { t: 'selected'; info: SelectionInfo; path: string[] }
  | { t: 'info'; info: SelectionInfo }
  | { t: 'cleared' }
  | { t: 'gone' }
  /** The selected element is hidden or gone for now (a hover preview, a closed menu); the selection is kept. */
  | { t: 'hoverOnly'; on: boolean }
  /** start/end: which of the `total` child elements are in `nodes` (the element's decorations come first, whichever part is loaded); view: the view it was built for. */
  | { t: 'children'; id: string; nodes: TreeNode[]; start: number; end: number; total: number; view: ElementView }
  | { t: 'treeChanged'; ids: string[] }
  /** The answer to aiContext: the description, and the edit base for each ref in it (plus "similar" and "page"). */
  | { t: 'aiContext'; text: string; refs: Record<string, EditBase> }
  /** A change made on the page (toolbar, drag, resize, keys): becomes one undo step. */
  | { t: 'commit'; edits: VisualEdit[]; label: string }
  | { t: 'undo' }
  | { t: 'redo' }
  | { t: 'openOptions' }
  /** Something the person should know (an element that cannot be edited reliably). */
  | { t: 'notice'; text: string };
