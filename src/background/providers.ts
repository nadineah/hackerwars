import type { Usage } from '../shared/types';

/**
 * The only provider-specific code: turning one neutral request into an Anthropic or OpenAI API call
 * and reading the model's single forced tool call back out. Prompt building lives in anthropic.ts and
 * produces Anthropic-shaped messages; the OpenAI sender converts them.
 */

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Anthropic-shaped content block (text or base64 image), as built by the prompt builder. */
export type Block =
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

export interface Msg {
  role: 'user' | 'assistant';
  content: string | Block[];
}

export interface SendArgs {
  apiKey: string;
  model: string;
  system: string;
  tool: ToolDef;
  messages: Msg[];
  signal?: AbortSignal;
}

export interface Raw {
  /** The tool call's arguments, or null if the model did not call the tool. */
  toolInput: Record<string, unknown> | null;
  /** True if the output was cut off by the token limit. */
  truncated: boolean;
  usage: Usage;
}

const MAX_OUTPUT_TOKENS = 12_000;

async function errorDetail(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return body?.error?.message ?? '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------------------- Anthropic

export async function sendAnthropic(a: SendArgs): Promise<Raw> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: a.signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': a.apiKey,
      'anthropic-version': '2023-06-01',
      // Required for browser-origin requests. DEV ONLY: production must use a backend proxy.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: a.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      // Cache breakpoint 1: tools + the (static) system prompt.
      system: [{ type: 'text', text: a.system, cache_control: { type: 'ephemeral' } }],
      tools: [a.tool],
      messages: a.messages,
    }),
  });
  if (!res.ok) {
    const detail = await errorDetail(res);
    throw new Error(`Anthropic API error ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  const data = await res.json();
  const block = (data.content as Array<{ type: string; input?: Record<string, unknown> }>).find((b) => b.type === 'tool_use');
  return {
    toolInput: block?.input ?? null,
    truncated: data.stop_reason === 'max_tokens',
    usage: {
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
      cacheReadTokens: data.usage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: data.usage?.cache_creation_input_tokens ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------------------- OpenAI

type OpenAIPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

/** Anthropic-shaped messages -> OpenAI chat messages (cache_control is dropped: OpenAI caches prefixes itself). */
export function toOpenAIMessages(system: string, messages: Msg[]): Array<{ role: string; content: string | OpenAIPart[] }> {
  const out: Array<{ role: string; content: string | OpenAIPart[] }> = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const parts: OpenAIPart[] = m.content.map((b) =>
      b.type === 'text'
        ? { type: 'text', text: b.text }
        : { type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } },
    );
    out.push({ role: m.role, content: parts });
  }
  return out;
}

export async function sendOpenAI(a: SendArgs): Promise<Raw> {
  const base = {
    model: a.model,
    // Newer OpenAI models reject the older `max_tokens` name.
    max_completion_tokens: MAX_OUTPUT_TOKENS,
    messages: toOpenAIMessages(a.system, a.messages),
    tools: [{ type: 'function', function: { name: a.tool.name, description: a.tool.description, parameters: a.tool.input_schema } }],
  };
  const post = (extra: Record<string, unknown>) =>
    fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: a.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${a.apiKey}` },
      body: JSON.stringify({ ...base, ...extra }),
    });

  // Force the design tool; if a model rejects forced tool choice, retry letting it choose.
  let res = await post({ tool_choice: { type: 'function', function: { name: a.tool.name } } });
  if (res.status === 400) {
    const detail = await errorDetail(res.clone());
    if (/tool_choice/i.test(detail)) res = await post({});
  }
  if (!res.ok) {
    const detail = await errorDetail(res);
    throw new Error(`OpenAI API error ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  const data = await res.json();
  const choice = data.choices?.[0];
  let toolInput: Record<string, unknown> | null = null;
  const args = choice?.message?.tool_calls?.[0]?.function?.arguments;
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args);
      if (parsed && typeof parsed === 'object') toolInput = parsed;
    } catch {
      /* truncated or malformed JSON: treated as "no design returned" */
    }
  }
  const cached = data.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    toolInput,
    truncated: choice?.finish_reason === 'length',
    usage: {
      // prompt_tokens includes the cached portion; report it the way the panel expects (uncached + cached).
      inputTokens: Math.max(0, (data.usage?.prompt_tokens ?? 0) - cached),
      outputTokens: data.usage?.completion_tokens ?? 0,
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
    },
  };
}
