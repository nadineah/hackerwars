// Gradients in Edit Mode: reading and writing them, and that every use survives edit validation and the sanitizer.
import { compileEdits, validateEdits } from '../src/shared/edits';
import { currentGradient, gradientCss, gradientPatch, parseGradient, partnerOf, type Gradient } from '../src/shared/gradient';
import { sanitizeCss } from '../src/shared/validate';

let fails = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) fails++;
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : JSON.stringify(extra)?.slice(0, 400));
};

const g: Gradient = { kind: 'linear', angle: 135, stops: ['#7a5ea8', '#f6c177'] };
ok('writes a linear gradient', gradientCss(g) === 'linear-gradient(135deg, #7a5ea8, #f6c177)', gradientCss(g));
ok('writes a radial one', gradientCss({ ...g, kind: 'radial' }) === 'radial-gradient(circle, #7a5ea8, #f6c177)');
ok('reads back what it wrote', JSON.stringify(parseGradient(gradientCss(g))) === JSON.stringify(g), parseGradient(gradientCss(g)));
const computed = parseGradient('linear-gradient(135deg, rgb(122, 94, 168) 0%, rgba(246, 193, 119, 0.5) 100%)');
ok('reads the browser computed form (rgb stops with commas, positions)', !!computed && computed.stops.length === 2 && computed.stops[1] === 'rgba(246, 193, 119, 0.5)', computed);
ok('reads "to right" as 90deg', parseGradient('linear-gradient(to right, red, blue)')?.angle === 90);
ok('reads a radial with a shape', parseGradient('radial-gradient(circle at center, red, blue)')?.kind === 'radial');
ok('reads a border-image value (with its slice)', parseGradient('linear-gradient(90deg, red, blue) 1')?.angle === 90);
ok('not a gradient: a picture, several layers, none', parseGradient('url("data:image/png;base64,AA")') === null && parseGradient('linear-gradient(red, blue), url(x)') === null && parseGradient('none') === null);
ok('a third colour is kept, more are cut to three', parseGradient('linear-gradient(90deg, red, green, blue, black)')?.stops.length === 3);

const text = gradientPatch('text', g);
ok('text: clipped to the text, its fill see-through, its colour the first stop', text['background-clip'] === 'text' && text['-webkit-text-fill-color'] === 'transparent' && text.color === '#7a5ea8');
ok('text off: only the gradient parts are taken away (not the colour)', Object.values(gradientPatch('text', null)).every((v) => v === null) && !('color' in gradientPatch('text', null)));
ok('border: a border image', gradientPatch('border', g)['border-image'] === `${gradientCss(g)} 1`);
const val = (css: Record<string, string>) => (p: string) => css[p] ?? '';
ok('the background reads as a gradient, unless the text uses it', !!currentGradient('background', val({ 'background-image': gradientCss(g) })) && !currentGradient('background', val({ 'background-image': gradientCss(g), '-webkit-text-fill-color': 'rgba(0, 0, 0, 0)' })) && !!currentGradient('text', val({ 'background-image': gradientCss(g), '-webkit-text-fill-color': 'rgba(0, 0, 0, 0)' })));
ok('a partner colour differs', partnerOf('#7a5ea8') !== '#7a5ea8' && /^#[0-9a-f]{6}$/.test(partnerOf('#7a5ea8')));

// every use, through validation and the sanitizer (overlay stops have an alpha)
const overlay = gradientCss({ ...g, stops: ['rgba(122, 94, 168, 0.35)', 'rgba(246, 193, 119, 0.35)'] });
const edits = validateEdits([
  { id: 'ea000001', target: { selectors: ['#a'], tag: 'div' }, label: 'a', origin: 'site', css: { ...gradientPatch('background', g), ...gradientPatch('border', g) }, updatedAt: 1 },
  { id: 'ea000002', target: { selectors: ['#b'], tag: 'h1' }, label: 'b', origin: 'site', css: gradientPatch('text', g) as Record<string, string>, hover: gradientPatch('text', { ...g, kind: 'radial' }) as Record<string, string>, updatedAt: 1 },
  { id: 'ea000003', target: { selectors: ['#c'], tag: 'div' }, label: 'c', origin: 'site', css: {}, hover: { 'background-image': overlay, 'background-color': 'transparent', opacity: '1' }, updatedAt: 1 },
]);
// validation writes values compactly ("…)1", no spaces after commas): compared by what they mean
const same = (v: string | undefined, want: Gradient) => JSON.stringify(parseGradient(v)?.stops.map((c) => c.replace(/\s+/g, '').replace(/,0\./g, ',.'))) === JSON.stringify(want.stops.map((c) => c.replace(/\s+/g, '').replace(/,0\./g, ',.'))) && parseGradient(v)?.kind === want.kind;
ok('validation keeps every gradient declaration', edits.length === 3 && same(edits[0].css['background-image'], g) && same(edits[0].css['border-image'], g) && edits[1].css['background-clip'] === 'text' && edits[1].css['-webkit-text-fill-color'] === 'transparent' && same(edits[1].hover?.['background-image'], { ...g, kind: 'radial' }) && same(edits[2].hover?.['background-image'], parseGradient(overlay)!), edits);
const out = sanitizeCss(compileEdits(edits));
ok('the compiled gradients survive the sanitizer', out.includes('linear-gradient(135deg') && out.includes('radial-gradient(circle') && /background-clip:\s*text/.test(out) && /border-image:\s*linear-gradient/.test(out) && out.includes('rgba('), out);

console.log(fails ? `${fails} FAILED` : 'ALL OK');
process.exit(fails ? 1 : 0);
