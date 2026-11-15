import { generateDesign } from '../src/background/anthropic';
import { providerOf, supportsImages } from '../src/shared/types';

type Call = { url: string; headers: Record<string, string>; body: any };
const calls: Call[] = [];
let queue: Array<(call: Call) => { status?: number; json: any }> = [];
(globalThis as any).fetch = async (url: string, init: any) => {
  const call = { url, headers: init.headers, body: JSON.parse(init.body) };
  calls.push(call);
  const r = (queue.shift() ?? (() => ({ json: {} })))(call);
  const status = r.status ?? 200;
  const res: any = { ok: status < 400, status, json: async () => r.json, clone: () => ({ json: async () => r.json }) };
  return res;
};
let fails = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) fails++;
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : JSON.stringify(extra)?.slice(0, 400));
};
const oaiReply = (input: any, usage: any = { prompt_tokens: 100, completion_tokens: 20 }, finish = 'tool_calls') => ({
  json: { choices: [{ finish_reason: finish, message: { tool_calls: [{ type: 'function', function: { name: 'submit_design', arguments: typeof input === 'string' ? input : JSON.stringify(input) } }] } }], usage },
});
const base: any = { model: 'gpt-5.5', host: 'h', path: '/', scope: 'site', pageContext: 'CTX', prompt: 'make it cozy', history: [] };
const shot = [{ mediaType: 'image/jpeg' as const, data: 'AAAA', label: 'screenshot' as const }];

(async () => {
  // ---- routing helpers
  ok('claude ids -> anthropic', providerOf('claude-sonnet-5-5') === 'anthropic' && providerOf('Claude-whatever') === 'anthropic');
  ok('gpt / unknown ids -> openai', providerOf('gpt-5.5') === 'openai' && providerOf('o3-mini') === 'openai' && providerOf('my-finetune') === 'openai');
  ok('listed models report image support', supportsImages('gpt-5.5') && supportsImages('claude-haiku-5-5'));
  ok('unlisted OpenAI id assumed image-capable; unlisted Claude id text-only', supportsImages('gpt-x') && !supportsImages('claude-unknown'));

  // ---- OpenAI request shape
  queue = [() => oaiReply({ name: 'Cozy', reply: 'Done', css: 'body{background:#fa0}', ops: [] }, { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } })];
  const out = await generateDesign({ ...base, provider: 'openai', apiKey: 'sk-openai', images: shot });
  const c = calls[calls.length - 1];
  ok('posts to the OpenAI chat completions endpoint', c.url === 'https://api.openai.com/v1/chat/completions', c.url);
  ok('uses Bearer auth and none of Anthropic\'s headers', c.headers.authorization === 'Bearer sk-openai' && !('x-api-key' in c.headers) && !('anthropic-version' in c.headers), c.headers);
  ok('uses max_completion_tokens (not max_tokens)', c.body.max_completion_tokens === 20000 && !('max_tokens' in c.body), Object.keys(c.body));
  ok('first message is the system prompt', c.body.messages[0].role === 'system' && /WhimsyWeb/.test(c.body.messages[0].content));
  const user = c.body.messages[c.body.messages.length - 1];
  ok('image becomes an image_url data URL part', Array.isArray(user.content) && user.content.some((p: any) => p.type === 'image_url' && p.image_url.url === 'data:image/jpeg;base64,AAAA'), user.content?.map((p: any) => p.type));
  ok('no Anthropic cache_control / image blocks leak into the request', !JSON.stringify(c.body).includes('cache_control') && !JSON.stringify(c.body).includes('"source"'));
  ok('page context and request text are present', JSON.stringify(c.body.messages).includes('CTX') && JSON.stringify(c.body.messages).includes('make it cozy'));
  ok('the design tool is a function with the schema', c.body.tools[0].type === 'function' && c.body.tools[0].function.name === 'submit_design' && !!c.body.tools[0].function.parameters.properties.css);
  ok('tool choice is forced to the design tool', c.body.tool_choice?.function?.name === 'submit_design', c.body.tool_choice);
  ok('design parsed from tool_calls arguments', out.css === 'body{background:#fa0}' && out.name === 'Cozy' && out.reply === 'Done', out);
  ok('usage: cached tokens split out of prompt tokens', out.usage.inputTokens === 200 && out.usage.cacheReadTokens === 800 && out.usage.outputTokens === 50, out.usage);

  // ---- history is sent as role-alternating messages
  queue = [() => oaiReply({ name: 'n', reply: 'r', css: 'a{}' })];
  await generateDesign({ ...base, provider: 'openai', apiKey: 'k', history: [{ role: 'user', text: 'first' }, { role: 'assistant', text: 'ok' }] });
  const roles = calls[calls.length - 1].body.messages.map((m: any) => m.role).join();
  ok('history keeps user/assistant alternation after the system message', roles === 'system,user,assistant,user', roles);

  // ---- forced tool_choice rejected -> retry without it
  const before = calls.length;
  queue = [() => ({ status: 400, json: { error: { message: "Invalid value for 'tool_choice': this model does not support it" } } }), () => oaiReply({ name: 'n', reply: 'r', css: 'a{color:red}' })];
  const retried = await generateDesign({ ...base, provider: 'openai', apiKey: 'k' });
  ok('retries once without tool_choice when a model rejects it', calls.length === before + 2 && !('tool_choice' in calls[calls.length - 1].body) && retried.css === 'a{color:red}', calls.slice(before).map((x) => 'tool_choice' in x.body));

  // ---- errors
  queue = [() => ({ status: 401, json: { error: { message: 'Incorrect API key provided' } } })];
  let err = '';
  await generateDesign({ ...base, provider: 'openai', apiKey: 'bad' }).catch((e) => (err = e.message));
  ok('API errors surface with the provider name and message', /OpenAI API error 401: Incorrect API key/.test(err), err);

  queue = [() => oaiReply('{"name":"x","css":"a{', {}, 'length')];
  err = '';
  await generateDesign({ ...base, provider: 'openai', apiKey: 'k' }).catch((e) => (err = e.message));
  ok('truncated output is reported as cut off', /cut off/.test(err), err);

  queue = [() => ({ json: { choices: [{ finish_reason: 'stop', message: { content: 'hello' } }], usage: {} } })];
  err = '';
  await generateDesign({ ...base, provider: 'openai', apiKey: 'k' }).catch((e) => (err = e.message));
  ok('no tool call is reported as no design', /did not return a design/.test(err), err);

  // ---- image tokens still round-trip on the OpenAI path
  const big = 'data:image/png;base64,' + 'B'.repeat(5000);
  queue = [(call) => { const tok = (JSON.stringify(call.body.messages.slice(1)).match(/ww-asset-[0-9a-f]{8}:[0-9]+/) ?? [''])[0]; return oaiReply({ name: 'n', reply: 'r', css: `a{background:url("${tok}")}` }); }];
  const t = await generateDesign({ ...base, provider: 'openai', apiKey: 'k', base: { name: 'b', css: `a{background:url("${big}")}`, ops: [] } });
  ok('big embedded images are tokenized out and restored on OpenAI too', !JSON.stringify(calls[calls.length - 1].body).includes('BBBBBBBBBB') && t.css.includes(big));

  // ---- Anthropic path is unchanged
  queue = [() => ({ json: { content: [{ type: 'tool_use', input: { name: 'n', reply: 'r', css: 'a{}' } }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 } } })];
  const an = await generateDesign({ ...base, model: 'claude-sonnet-5-5', provider: 'anthropic', apiKey: 'sk-ant', images: shot });
  const ca = calls[calls.length - 1];
  ok('Anthropic: endpoint + headers unchanged', ca.url === 'https://api.anthropic.com/v1/messages' && ca.headers['x-api-key'] === 'sk-ant' && ca.headers['anthropic-version'] === '2023-06-01' && !('authorization' in ca.headers), ca.headers);
  ok('Anthropic: system prompt is a cached block, images are image blocks', ca.body.system[0].cache_control?.type === 'ephemeral' && JSON.stringify(ca.body.messages).includes('"type":"image"') && ca.body.max_tokens === 20000);
  ok('Anthropic: usage mapping unchanged', an.usage.inputTokens === 10 && an.usage.cacheReadTokens === 7 && an.usage.cacheWriteTokens === 3, an.usage);

  // ---- M1 (fable review): reasoning effort only for models documented to accept it
  const effortCase = async (provider: 'anthropic' | 'openai', model: string) => {
    queue = [() => (provider === 'openai' ? oaiReply({ name: 'n', reply: 'r', css: 'a{}' }) : { json: { content: [{ type: 'tool_use', input: { name: 'n', reply: 'r', css: 'a{}' } }], usage: {} } })];
    await generateDesign({ ...base, model, provider, apiKey: 'k' });
    return calls[calls.length - 1].body;
  };
  for (const m of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-haiku-5-5']) {
    const b = await effortCase('anthropic', m);
    ok('Anthropic ' + m + ': sends output_config.effort = medium', b.output_config?.effort === 'medium', b.output_config);
  }
  for (const m of ['claude-3-5-sonnet-latest', 'claude-unknown', 'claude-haiku-4-5']) {
    const b = await effortCase('anthropic', m);
    ok('Anthropic ' + m + ': no effort field (unknown/older ids could 400)', !('output_config' in b), b.output_config);
  }
  for (const m of ['gpt-5.5', 'gpt-5.4', 'o3-mini']) {
    const b = await effortCase('openai', m);
    ok('OpenAI ' + m + ': sends reasoning_effort = medium', b.reasoning_effort === 'medium', b.reasoning_effort);
  }
  for (const m of ['gpt-4o', 'my-custom-model', 'o1-mini']) {
    const b = await effortCase('openai', m);
    ok('OpenAI ' + m + ': no reasoning_effort (non-reasoning models reject it)', !('reasoning_effort' in b), b.reasoning_effort);
  }
  const ab = await effortCase('anthropic', 'claude-sonnet-5-5');
  ok('Anthropic: tool_choice is not forced (forced tool use 400s on the 5.x models)', !('tool_choice' in ab), ab.tool_choice);
  ok('Anthropic: thinking is not disabled or given a budget (both 400 on the 5.x models)', !('thinking' in ab) && !JSON.stringify(ab).includes('budget_tokens'));

  console.log(fails ? `${fails} FAILED` : 'ALL OK');
  process.exit(fails ? 1 : 0);
})();
