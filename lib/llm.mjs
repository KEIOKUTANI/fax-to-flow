// Minimal OpenAI-compatible chat-completions client for Nebius Token Factory.
// No SDK: plain fetch, so the app runs with zero dependencies.

export const config = {
  baseUrl: (process.env.LLM_BASE_URL || 'https://api.tokenfactory.nebius.com/v1').replace(/\/+$/, ''),
  apiKey: process.env.NEBIUS_API_KEY || '',
  llmModel: process.env.LLM_MODEL || 'nvidia/nemotron-3-super-120b-a12b',
  visionModel: process.env.VISION_MODEL || 'Qwen/Qwen2-VL-72B-Instruct',
  timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 120000),
};

export const isLive = () => Boolean(config.apiKey);

export class LLMError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/**
 * POST /chat/completions. Returns { message, usage, raw }.
 * `message` is choices[0].message: { role, content, tool_calls?, reasoning_content? }.
 */
export async function chatCompletion(body) {
  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new LLMError(`Token Factory ${res.status}: ${text.slice(0, 300)}`, res.status, text);
  let json;
  try { json = JSON.parse(text); } catch { throw new LLMError('Non-JSON response from Token Factory', res.status, text); }
  const message = json.choices?.[0]?.message;
  if (!message) throw new LLMError('No choices in response', res.status, text);
  return { message, usage: json.usage, finish_reason: json.choices[0].finish_reason, raw: json };
}

/** Strip <think>…</think> blocks some reasoning models put in `content`. */
export function stripThinking(s) {
  return String(s ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^[\s\S]*<\/think>/, '').trim();
}

/** Pull the first JSON object out of a model reply (handles ```json fences and chatter). */
export function extractJson(s) {
  const text = stripThinking(s);
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  if (start < 0) throw new Error('no JSON object in model output');
  let depth = 0;
  let inStr = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return JSON.parse(candidate.slice(start, i + 1));
  }
  throw new Error('unterminated JSON object in model output');
}

/** Parse tool_call.function.arguments (a JSON string per the spec; tolerate objects). */
export function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return extractJson(raw); }
}
