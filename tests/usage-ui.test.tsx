import { renderToStaticMarkup } from 'react-dom/server';
import { UsageSection } from '../src/sidepanel/App';

const t = (i: number, o: number, cr = 0, cw = 0, req = 1) => ({ inputTokens: i, outputTokens: o, cacheReadTokens: cr, cacheWriteTokens: cw, requests: req });
let fails = 0;
const ok = (n: string, c: boolean, x?: unknown) => { if (!c) fails++; console.log(c ? 'ok  ' : 'FAIL', n, c ? '' : String(x).slice(0, 300)); };
const noop = () => {};

const empty = renderToStaticMarkup(<UsageSection usage={{ since: null, anthropic: t(0, 0, 0, 0, 0), openai: t(0, 0, 0, 0, 0), byModel: {} }} selected="anthropic" onReset={noop} />);
ok('empty state says nothing used yet and shows 0 total', empty.includes('Nothing used yet') && empty.includes('0 total'), empty);
ok('empty state has no reset button', !empty.includes('Reset counts'));
ok('loading state', renderToStaticMarkup(<UsageSection usage={null} selected="openai" onReset={noop} />).includes('Loading'));

const usage = {
  since: Date.UTC(2026, 10, 1),
  anthropic: t(1000, 500, 8000, 500, 12), // total 10,000
  openai: t(2000, 2000, 0, 0, 3),         // total 4,000
  byModel: {
    'claude-sonnet-5-5': { provider: 'anthropic' as const, ...t(1000, 500, 8000, 500, 12) },
    'gpt-5.5': { provider: 'openai' as const, ...t(2000, 2000, 0, 0, 3) },
  },
};
const html = renderToStaticMarkup(<UsageSection usage={usage} selected="openai" onReset={noop} />);
ok('grand total = 14.0k across both providers', html.includes('14.0k total'), html.slice(0, 200));
ok('each provider shows its own total (10.0k and 4.0k)', html.includes('>10.0k<') && html.includes('>4.0k<'), html);
ok('share bar: anthropic 10000/14000 = 71.4%, openai 28.6%', html.includes('width:71.42') && html.includes('width:28.57'), (html.match(/width:[0-9.]+%/g) ?? []).join(' '));
ok('provider breakdown bar: anthropic cached 8500/10000 = 85%', html.includes('width:85%'), (html.match(/width:[0-9.]+%/g) ?? []).join(' '));
ok('only the selected provider is highlighted', (html.match(/usage-card selected/g) ?? []).length === 1 && /selected[^]*?OpenAI \(GPT\)[^]*?selected model/.test(html), html.match(/usage-card[^"]*/g));
ok('cached tokens are labelled (read+write = 8.5k)', html.includes('Cached 8.5k'));
ok('request counts with singular/plural', html.includes('12 requests') && html.includes('3 requests'));
ok('per-model rows appear under their provider', html.includes('claude-sonnet-5-5') && html.includes('gpt-5.5'));
ok('exact figures are in tooltips', html.includes('14,000 tokens') || html.includes('14.000 tokens') || html.includes('14000'), html.match(/title="[^"]*tokens"/g)?.slice(0, 2));
ok('the start date and a cost disclaimer are shown', /since \d/.test(html) && html.includes('not cost'));
ok('bars are accessible (role=img with a label)', (html.match(/role="img"/g) ?? []).length === 3 && html.includes('aria-label="Share of total tokens'));
ok('a reset button appears once there is usage', html.includes('Reset counts'));
console.log(fails ? `${fails} FAILED` : 'ALL OK');
process.exit(fails ? 1 : 0);
