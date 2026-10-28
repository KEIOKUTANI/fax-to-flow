// Live smoke test against Nebius Token Factory. Run once NEBIUS_API_KEY is set:
//   npm run smoke
// 1) lists the catalogue and flags Nemotron / vision models (so VISION_MODEL can be switched to an NVIDIA VL model if one exists),
// 2) checks the configured models answer, 3) runs sample2 (the messy FAX) end to end.
import fs from 'node:fs';
import path from 'node:path';
import { config, chatCompletion, resolveVisionModel, stripThinking } from '../lib/llm.mjs';
import { transcribeFax, runAgent } from '../lib/agent.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const log = (ok, name, detail = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
let failed = false;

if (!config.apiKey) {
  log(false, 'NEBIUS_API_KEY is set');
  process.exit(1);
}

try {
  const res = await fetch(`${config.baseUrl}/models?verbose=true`, { headers: { Authorization: `Bearer ${config.apiKey}` } });
  const { data = [] } = await res.json();
  const nvidia = data.filter((m) => /nvidia|nemotron/i.test(m.id));
  const vision = data.filter((m) => /image|vision|vl/i.test(`${m.id} ${m.architecture?.modality || ''}`));
  log(true, `Catalogue: ${data.length} models`,
    `Nemotron/NVIDIA: ${nvidia.map((m) => m.id).join(', ') || 'none'}\n      Vision-capable: ${vision.map((m) => m.id).join(', ') || 'none'}`);
  await resolveVisionModel();
  for (const id of [config.llmModel, config.visionModel]) {
    const found = data.some((m) => m.id === id);
    if (!found) failed = true;
    log(found, `Configured model listed: ${id}`);
  }
  const nvVision = vision.filter((m) => /nvidia|nemotron/i.test(m.id));
  if (nvVision.length) console.log(`TIP   An NVIDIA vision model is available: set VISION_MODEL=${nvVision[0].id} to make the whole pipeline NVIDIA.`);
} catch (e) {
  failed = true;
  log(false, 'List models', e.message);
}

try {
  const t0 = Date.now();
  const { message } = await chatCompletion({ model: config.llmModel, messages: [{ role: 'user', content: '「承知しました」を丁寧な敬語で一文に言い換えてください。' }], max_tokens: 800 });
  log(true, `Nemotron answers (${Date.now() - t0}ms)`, stripThinking(message.content).slice(0, 120));
} catch (e) {
  failed = true;
  log(false, 'Nemotron answers', e.message);
}

try {
  const t0 = Date.now();
  const img = fs.readFileSync(path.join(ROOT, 'samples/sample2_messy.png')).toString('base64');
  const steps = [];
  const emit = (s) => steps.push(s.title);
  const transcription = await transcribeFax(`data:image/png;base64,${img}`, emit);
  const order = await runAgent(transcription, emit);
  const lines = order.lines || [];
  const ok = lines.length >= 3;
  if (!ok) failed = true;
  log(ok, `sample2 end to end (${Math.round((Date.now() - t0) / 1000)}s, ${steps.length} steps)`,
    lines.map((l) => `${l.raw_text ?? ''} → ${l.sku ?? '?'} ×${l.qty ?? '?'} [${l.status ?? ''}]`).join('\n      '));
  fs.writeFileSync(path.join(ROOT, 'docs/smoke-sample2.json'), JSON.stringify({ transcription, order, steps }, null, 2));
  console.log('      full output: docs/smoke-sample2.json (compare with fixtures/sample2_messy.json)');
} catch (e) {
  failed = true;
  log(false, 'sample2 end to end', e.message);
}

process.exitCode = failed ? 1 : 0;
