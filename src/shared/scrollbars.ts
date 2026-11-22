import type { CssNode } from 'css-tree';
import generate from 'css-tree/generator';
import parse from 'css-tree/parser';
import walk from 'css-tree/walker';

/**
 * Chrome ignores ::-webkit-scrollbar styling (the kind that allows gradients, rounded thumbs, borders) on any
 * scrollbar the standard scrollbar-color / scrollbar-width properties apply to. Sites often set those (YouTube does,
 * on the whole page), so a design's scrollbar styling would silently not show. For the scrollbars a design styles,
 * this returns a rule that puts those two properties back to auto, so the design's styling is what Chrome draws.
 */
export function scrollbarReset(css: string): string {
  if (!/::-webkit-scrollbar/i.test(css)) return '';
  const scopes = new Set<string>();
  let everywhere = false;
  let ast: CssNode;
  try {
    ast = parse(css, { parseValue: false, parseAtrulePrelude: false, parseCustomProperty: false });
  } catch {
    return '';
  }
  walk(ast, {
    visit: 'Rule',
    enter(node: CssNode) {
      const prelude = (node as CssNode & { prelude: CssNode }).prelude;
      const text = generate(prelude);
      if (!/::-webkit-scrollbar/i.test(text)) return;
      for (const part of text.split(',')) {
        if (!/::-webkit-scrollbar/i.test(part)) continue;
        const base = part.replace(/::-webkit-scrollbar[\w-]*(?::[\w-]+(?:\([^)]*\))?)*/gi, '').trim();
        if (!base || base === '*' || /^(html|body|:root)$/i.test(base)) everywhere = true;
        else if (base.length <= 200 && !/[{};]/.test(base)) scopes.add(base);
      }
    },
  });
  const decl = '{scrollbar-color:auto!important;scrollbar-width:auto!important}';
  if (everywhere) return `:root,:root *${decl}`;
  return scopes.size ? `${[...scopes].join(',')}${decl}` : '';
}
