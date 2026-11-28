/**
 * Removes `@import` rules from a stylesheet's text. Built stylesheets (`CSSStyleSheet.replaceSync`) cannot load them:
 * Chrome skips each one and logs "@import rules are not allowed here".
 *
 * This reads the CSS rather than pattern-matching it, so only real rules go: an "@import" inside a comment, a string
 * or a block is left alone. A regex cannot tell those apart, and cutting text out of a comment can leave it unclosed,
 * which hides every rule after it.
 */
export function withoutImports(css: string): string {
  const n = css.length;
  let out = '';
  let from = 0; // start of the text not yet copied to `out`
  let depth = 0; // inside { } blocks
  let i = 0;

  /** Index just past a quoted string starting at `at` (an unclosed string runs to the end of its line, as in CSS). */
  const skipString = (at: number): number => {
    const q = css[at];
    let j = at + 1;
    while (j < n && css[j] !== q) {
      if (css[j] === '\\') j += 2;
      else if (css[j] === '\n') return j;
      else j++;
    }
    return Math.min(j + 1, n);
  };
  /** Index just past a comment starting at `at` (an unclosed comment runs to the end). */
  const skipComment = (at: number): number => {
    const end = css.indexOf('*/', at + 2);
    return end < 0 ? n : end + 2;
  };

  while (i < n) {
    const c = css[i];
    if (c === '/' && css[i + 1] === '*') i = skipComment(i);
    else if (c === '"' || c === "'") i = skipString(i);
    else if (c === '{') { depth++; i++; }
    else if (c === '}') { depth = Math.max(0, depth - 1); i++; }
    else if (c === '@' && depth === 0 && /^@import(?![\w-])/i.test(css.slice(i, i + 8))) {
      // the rule ends at the first ";" outside strings, comments and brackets (or a "{", which would make it invalid
      // anyway; leave that for the browser to discard so the block after it is not swallowed)
      let j = i + 7;
      let parens = 0;
      while (j < n) {
        const d = css[j];
        if (d === '/' && css[j + 1] === '*') j = skipComment(j);
        else if (d === '"' || d === "'") j = skipString(j);
        else if (d === '(') { parens++; j++; }
        else if (d === ')') { parens = Math.max(0, parens - 1); j++; }
        else if (parens === 0 && (d === ';' || d === '{' || d === '}')) break;
        else j++;
      }
      if (j < n && css[j] !== ';') { i = j; continue; } // not a complete statement: leave it
      out += css.slice(from, i);
      i = from = Math.min(j + 1, n);
    } else i++;
  }
  return out + css.slice(from);
}
