import { supportsClaudeEffort, supportsOpenAIReasoningEffort } from '../../src/background/providers';
import type { Usage } from '../../src/shared/types';

/**
 * The model drives. Instead of the lab running a fixed workflow, the model is given tools (take a screenshot, apply CSS to the
 * page, generate an image, submit the design) and the PROMPT decides the order, how many pictures, how many refinement rounds.
 * This file is only the loop: call the model, run the tools it asks for, hand the results back, repeat until it submits.
 */

export interface AgentTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolResult {
  /** What the model is told happened. */
  text: string;
  /** Pictures shown to the model with the result (screenshots, generated images). */
  images?: { base64: string; mediaType: 'image/jpeg' }[];
  /** True when the design was submitted: the loop ends. */
  final?: boolean;
}

export interface AgentEvent {
  kind: 'model' | 'tool' | 'note';
  title: string;
  detail?: string;
  thumbs?: { label: string; thumb: string }[];
  ms?: number;
}

export interface AgentOptions {
  provider: 'anthropic' | 'openai';
  apiKey: string;
  model: string;
  /** Exactly what the user wrote ('' = no system prompt at all). */
  system: string;
  /** The first user message (page outline, scope, request...). */
  userText: string;
  tools: AgentTool[];
  execute: (name: string, input: Record<string, unknown>) => Promise<ToolResult>;
  onUsage: (u: Usage) => void;
  onEvent: (e: AgentEvent) => void;
  signal: AbortSignal;
  /** Safety stop against a runaway loop (model calls). The prompt controls everything else. */
  maxTurns?: number;
}

export const SAFETY_MAX_TURNS = 200;
const MAX_OUTPUT_TOKENS = 30_000;
const EFFORT = 'medium';

async function errorOf(res: Response, who: string): Promise<Error> {
  let detail = '';
  try {
    detail = (await res.json())?.error?.message ?? '';
  } catch {
    /* no body */
  }
  return new Error(`${who} API error ${res.status}${detail ? `: ${detail}` : ''}`);
}

const NUDGE = 'Continue. When the design is finished, call the submit_design tool.';

export async function runAgent(o: AgentOptions): Promise<{ finished: boolean; reason: string }> {
  return o.provider === 'anthropic' ? runAnthropic(o) : runOpenAI(o);
}

// ------------------------------------------------------------------------------------------ Anthropic

async function runAnthropic(o: AgentOptions): Promise<{ finished: boolean; reason: string }> {
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [{ role: 'user', content: [{ type: 'text', text: o.userText }] }];
  let nudges = 0;
  const maxTurns = o.maxTurns ?? SAFETY_MAX_TURNS;
  for (let turn = 1; turn <= maxTurns; turn++) {
    if (o.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const t0 = Date.now();
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: o.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': o.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({
        model: o.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        ...(supportsClaudeEffort(o.model) ? { output_config: { effort: EFFORT } } : {}),
        ...(o.system.trim() ? { system: [{ type: 'text', text: o.system }] } : {}),
        tools: o.tools,
        messages,
      }),
    });
    if (!res.ok) throw await errorOf(res, 'Anthropic');
    const data = await res.json();
    o.onUsage({
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
      cacheReadTokens: data.usage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: data.usage?.cache_creation_input_tokens ?? 0,
    });
    const content = (data.content ?? []) as Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
    messages.push({ role: 'assistant', content });
    const said = content.filter((b) => b.type === 'text' && b.text?.trim()).map((b) => b.text!.trim()).join('\n');
    if (said) o.onEvent({ kind: 'model', title: `Model (turn ${turn})`, detail: said, ms: Date.now() - t0 });
    const uses = content.filter((b) => b.type === 'tool_use');
    if (!uses.length) {
      if (data.stop_reason === 'max_tokens') return { finished: false, reason: 'The model ran out of output space before finishing.' };
      if (++nudges > 2) return { finished: false, reason: 'The model stopped without submitting a design.' };
      messages.push({ role: 'user', content: [{ type: 'text', text: NUDGE }] });
      continue;
    }
    const results: unknown[] = [];
    let done = false;
    for (const u of uses) {
      const r = await o.execute(u.name ?? '', u.input ?? {});
      results.push({
        type: 'tool_result',
        tool_use_id: u.id,
        content: [{ type: 'text', text: r.text }, ...(r.images ?? []).map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.base64 } }))],
      });
      if (r.final) done = true;
    }
    messages.push({ role: 'user', content: results });
    if (done) return { finished: true, reason: 'Submitted.' };
  }
  return { finished: false, reason: `Stopped by the safety limit of ${maxTurns} model turns.` };
}

// ------------------------------------------------------------------------------------------ OpenAI (Responses API)

async function runOpenAI(o: AgentOptions): Promise<{ finished: boolean; reason: string }> {
  const input: unknown[] = [{ role: 'user', content: [{ type: 'input_text', text: o.userText }] }];
  let nudges = 0;
  const maxTurns = o.maxTurns ?? SAFETY_MAX_TURNS;
  for (let turn = 1; turn <= maxTurns; turn++) {
    if (o.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const t0 = Date.now();
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      signal: o.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${o.apiKey}` },
      body: JSON.stringify({
        model: o.model,
        ...(o.system.trim() ? { instructions: o.system } : {}),
        input,
        tools: o.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.input_schema, strict: false })),
        tool_choice: 'auto',
        max_output_tokens: MAX_OUTPUT_TOKENS,
        store: false,
        ...(supportsOpenAIReasoningEffort(o.model) ? { reasoning: { effort: EFFORT }, include: ['reasoning.encrypted_content'] } : {}),
      }),
    });
    if (!res.ok) throw await errorOf(res, 'OpenAI');
    const data = await res.json();
    const cached = data.usage?.input_tokens_details?.cached_tokens ?? 0;
    o.onUsage({ inputTokens: Math.max(0, (data.usage?.input_tokens ?? 0) - cached), outputTokens: data.usage?.output_tokens ?? 0, cacheReadTokens: cached });
    const out = (data.output ?? []) as Array<{ type: string; name?: string; call_id?: string; arguments?: string; content?: Array<{ type: string; text?: string }> }>;
    input.push(...out); // stateless: the model's own items (including its reasoning) go back in
    const said = out
      .filter((i) => i.type === 'message')
      .flatMap((i) => i.content ?? [])
      .filter((c) => c.type === 'output_text' && c.text?.trim())
      .map((c) => c.text!.trim())
      .join('\n');
    if (said) o.onEvent({ kind: 'model', title: `Model (turn ${turn})`, detail: said, ms: Date.now() - t0 });
    const calls = out.filter((i) => i.type === 'function_call');
    if (!calls.length) {
      if (data.status === 'incomplete') return { finished: false, reason: 'The model ran out of output space before finishing.' };
      if (++nudges > 2) return { finished: false, reason: 'The model stopped without submitting a design.' };
      input.push({ role: 'user', content: [{ type: 'input_text', text: NUDGE }] });
      continue;
    }
    const imageParts: unknown[] = [];
    let done = false;
    for (const c of calls) {
      let args: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(c.arguments ?? '{}');
        if (parsed && typeof parsed === 'object') args = parsed;
      } catch {
        /* malformed arguments: the tool reports it */
      }
      const r = await o.execute(c.name ?? '', args);
      input.push({ type: 'function_call_output', call_id: c.call_id, output: r.text });
      for (const img of r.images ?? []) {
        imageParts.push({ type: 'input_text', text: `Image returned by ${c.name}:` }, { type: 'input_image', image_url: `data:${img.mediaType};base64,${img.base64}` });
      }
      if (r.final) done = true;
    }
    if (imageParts.length) input.push({ role: 'user', content: imageParts });
    if (done) return { finished: true, reason: 'Submitted.' };
  }
  return { finished: false, reason: `Stopped by the safety limit of ${maxTurns} model turns.` };
}
