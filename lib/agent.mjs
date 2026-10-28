// The FAX to Flow pipeline (live mode).
//
//   1. Vision transcription  — VISION_MODEL (auto-picked from the Token Factory catalogue, NVIDIA VL preferred)
//      turns the fax image into a faithful raw transcription (JSON). It does NOT
//      match products or make decisions.
//   2. Nemotron agent loop   — LLM_MODEL (default NVIDIA Nemotron 3 Super) does all
//      reasoning: identifies the customer, matches each line, checks stock,
//      expands "the usual", proposes substitutes, and writes the keigo reply.
//      It uses OpenAI-style tool calling; if the endpoint rejects tools, we fall
//      back to a JSON-plan protocol where Nemotron emits actions and the server
//      executes them.
import { chatCompletion, config, extractJson, parseArgs, resolveVisionModel, stripThinking } from './llm.mjs';
import { TOOL_SCHEMAS, TOOL_NAMES, runTool, summarizeTool } from './tools.mjs';

const MAX_TURNS = 16;

const VISION_PROMPT = `You are transcribing a Japanese purchase-order FAX received by 大和金物 (Yamato Kanamono), a fastener wholesaler.
Transcribe faithfully. Do NOT correct, expand abbreviations, or guess product codes — copy what is written.
If a value is crossed out (二重線 / strike-through) and replaced, report both.
Return ONLY a JSON object with this shape:
{
  "fax_header": "text of the fax machine stamp line at the very top, if any",
  "sender": {"company": "", "contact": "", "fax": ""},
  "date": "",
  "lines": [{"line_no": 1, "item": "品名 as written", "spec": "規格 as written", "qty": "数量 as written incl. unit", "qty_crossed_out": "", "due": "納期 as written", "legibility": "clear|unsure"}],
  "free_text": "any notes, 備考, or free-form request text, verbatim",
  "unreadable": ["anything you could not read"]
}`;

function agentSystemPrompt(today) {
  return `You are the order-desk agent of 大和金物株式会社 (Yamato Kanamono), a hardware & fastener wholesaler in Higashi-Osaka. Today is ${today}.
A customer FAX has been transcribed (raw, uncorrected). Turn it into an order draft for a human clerk to approve.

Procedure:
1. lookup_customer with the fax number from the header (fall back to the company name).
2. If the note refers to the usual order ("いつもの", "前回と同じ", "倍で" etc.), call get_usual_order and expand it (apply multipliers such as 倍 = ×2).
3. For every written line, call search_products with the item + spec as written. If the result is "ambiguous" or the top score < 0.75, mark the line needs_check and list the alternatives — never silently guess.
4. check_stock for every chosen SKU and quantity. If short or zero, call propose_substitute. If a good substitute exists (same size & material, small length difference), use status "substitute" with original_sku set; if only part is short, split into two lines (in-stock part confirmed, remainder substitute).
5. A crossed-out and rewritten quantity: use the rewritten value but set status needs_check and say so in the note.
6. Infer due_date as ISO date (e.g. 金曜 = the coming Friday).
7. Call finalize_order ONCE with all lines, plus reply_ja: a polite business-Japanese (keigo) reply FAX body to the customer (start with the greeting — the system prints the 御中/様 addressee header and the item table separately), thanking them, confirming items, clearly asking for approval of any substitute and confirmation of any unclear line, and stating the delivery date. Use 「」 for product names. Do not include prices in the reply. Also give reply_en: a faithful English gloss, and summary_en: one sentence for the clerk.
Quantities are in the product's sales unit (箱/本/袋/セット). Prices are added by the server. Keep notes short. Be decisive but honest about uncertainty (confidence 0-1).`;
}

const todayIso = () => new Date().toISOString().slice(0, 10);

export async function transcribeFax(imageDataUrl, emit) {
  await resolveVisionModel();
  emit({ kind: 'vision', title: `Reading FAX… (${config.visionModel})`, detail: 'Vision model transcribes the image into raw JSON — no decisions yet.' });
  const { message } = await chatCompletion({
    model: config.visionModel,
    temperature: 0,
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: VISION_PROMPT },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ],
    }],
  });
  let transcription;
  try {
    transcription = extractJson(message.content);
  } catch {
    transcription = { free_text: stripThinking(message.content), lines: [], note: 'vision output was not JSON; passed as free text' };
  }
  emit({ kind: 'vision', title: `Transcribed ${transcription.lines?.length ?? 0} lines`, data: transcription });
  return transcription;
}

/** Run the Nemotron agent. Returns the validated order from finalize_order. */
export async function runAgent(transcription, emit) {
  const messages = [
    { role: 'system', content: agentSystemPrompt(todayIso()) },
    { role: 'user', content: `Raw FAX transcription:\n${JSON.stringify(transcription, null, 2)}` },
  ];
  emit({ kind: 'info', title: `Nemotron agent started (${config.llmModel})`, detail: 'OpenAI-style tool calling on Nebius Token Factory' });
  try {
    return await toolCallingLoop(messages, emit);
  } catch (e) {
    if (!e.fallback) throw e;
    emit({ kind: 'info', title: 'Tool calling unavailable → JSON-plan mode', detail: `${e.message}. Nemotron now returns a JSON plan; the server executes the tools.` });
    return jsonPlanLoop(transcription, emit);
  }
}

async function toolCallingLoop(messages, emit) {
  let nudged = false;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let message;
    try {
      ({ message } = await chatCompletion({
        model: config.llmModel,
        messages,
        tools: TOOL_SCHEMAS,
        tool_choice: 'auto',
        temperature: 0.2,
        max_tokens: Number(process.env.LLM_MAX_TOKENS || 8192),
      }));
    } catch (e) {
      // 400/422 on the very first call usually means the deployment rejects `tools`.
      if (turn === 0 && (e.status === 400 || e.status === 422 || e.status === 404)) Object.assign(e, { fallback: true });
      throw e;
    }

    const thought = stripThinking(message.content);
    const calls = message.tool_calls || [];
    if (thought && calls.length) emit({ kind: 'thought', title: 'Nemotron', detail: thought.slice(0, 400) });

    if (!calls.length) {
      if (!nudged) {
        nudged = true;
        messages.push({ role: 'assistant', content: message.content || '' });
        messages.push({ role: 'user', content: 'Please continue using the tools, and finish by calling finalize_order.' });
        continue;
      }
      throw Object.assign(new Error('model stopped without calling finalize_order'), { fallback: true });
    }

    // Echo the assistant turn back exactly (required by the tools protocol).
    messages.push({ role: 'assistant', content: message.content ?? '', tool_calls: calls });
    for (const call of calls) {
      const name = call.function?.name;
      let args;
      try { args = parseArgs(call.function?.arguments); } catch { args = {}; }
      const result = runTool(name, args);
      emit({ kind: 'tool', tool: name, args: name === 'finalize_order' ? undefined : args, title: name, detail: summarizeTool(name, args, result) });
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      if (name === 'finalize_order' && result.ok) return result.order;
    }
  }
  throw new Error(`agent did not finalize within ${MAX_TURNS} turns`);
}

// ---- Fallback: JSON-plan protocol (no native tool calling) -----------------

function jsonPlanSystem() {
  const toolDocs = TOOL_SCHEMAS.map((t) => `- ${t.function.name}(${Object.keys(t.function.parameters.properties).join(', ')}): ${t.function.description}`).join('\n');
  return `${agentSystemPrompt(todayIso())}

You cannot call tools directly. Instead, reply with ONLY one JSON object per turn:
  {"thought": "short reasoning", "actions": [{"tool": "<name>", "args": {...}}, ...]}
The server runs the actions and replies with their results. When ready, reply with:
  {"thought": "...", "actions": [{"tool": "finalize_order", "args": {...full finalize_order arguments...}}]}
Available tools:
${toolDocs}
finalize_order args: customer_id, due_date, lines[{line_no, raw_text, sku, qty, status, confidence, original_sku, alternatives, note_ja, note_en}], reply_ja, reply_en, summary_en.`;
}

async function jsonPlanLoop(transcription, emit) {
  const messages = [
    { role: 'system', content: jsonPlanSystem() },
    { role: 'user', content: `Raw FAX transcription:\n${JSON.stringify(transcription, null, 2)}` },
  ];
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let message;
    try {
      ({ message } = await chatCompletion({ model: config.llmModel, messages, temperature: 0.2, max_tokens: Number(process.env.LLM_MAX_TOKENS || 8192), response_format: { type: 'json_object' } }));
    } catch (e) {
      if (e.status !== 400 && e.status !== 422) throw e;
      ({ message } = await chatCompletion({ model: config.llmModel, messages, temperature: 0.2, max_tokens: Number(process.env.LLM_MAX_TOKENS || 8192) }));
    }
    messages.push({ role: 'assistant', content: message.content || '' });
    let plan;
    try {
      plan = extractJson(message.content);
    } catch (e) {
      messages.push({ role: 'user', content: `Your reply was not valid JSON (${e.message}). Reply with one JSON object only.` });
      continue;
    }
    if (plan.thought) emit({ kind: 'thought', title: 'Nemotron (plan)', detail: String(plan.thought).slice(0, 400) });
    const results = [];
    for (const action of plan.actions || []) {
      const name = action.tool;
      if (!TOOL_NAMES.includes(name)) { results.push({ tool: name, result: { error: 'unknown tool' } }); continue; }
      const result = runTool(name, action.args || {});
      emit({ kind: 'tool', tool: name, args: name === 'finalize_order' ? undefined : action.args, title: `${name} (server-executed)`, detail: summarizeTool(name, action.args, result) });
      if (name === 'finalize_order' && result.ok) return result.order;
      results.push({ tool: name, args: action.args, result });
    }
    messages.push({ role: 'user', content: `TOOL RESULTS:\n${JSON.stringify(results)}` });
  }
  throw new Error(`agent did not finalize within ${MAX_TURNS} turns (JSON-plan mode)`);
}
