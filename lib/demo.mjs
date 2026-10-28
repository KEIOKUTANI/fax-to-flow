// Demo mode (no NEBIUS_API_KEY): replays hand-authored fixtures for the three
// bundled samples so the UI can be explored without model calls.
// Tool calls in the script are executed for real against the product master;
// the transcription, the agent's decisions and the reply text are pre-written.
// Every event is tagged demo:true and the UI shows a "Demo mode" banner.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { finalizeOrder, runTool, summarizeTool } from './tools.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'fixtures');
const SAMPLES = path.join(ROOT, 'samples');

export const fixtures = new Map(
  fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort().map((f) => {
    const fx = JSON.parse(fs.readFileSync(path.join(FIXTURES, f), 'utf8'));
    return [fx.sample, fx];
  }),
);

export const samples = [...fixtures.values()].map((fx) => {
  const file = `${fx.sample}.png`;
  const buf = fs.readFileSync(path.join(SAMPLES, file));
  return { id: fx.sample, title: fx.title, url: `/samples/${file}`, file, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
});

/** Recognise an uploaded image that is byte-identical to a bundled sample. */
export function sampleIdForImage(buffer) {
  const h = crypto.createHash('sha256').update(buffer).digest('hex');
  return samples.find((s) => s.sha256 === h)?.id || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function replayFixture(sampleId, emit, { delayMs = 380 } = {}) {
  const fx = fixtures.get(sampleId);
  if (!fx) throw new Error(`no demo fixture for ${sampleId}`);
  const demo = true;
  emit({ demo, kind: 'info', title: 'Demo mode — replaying a pre-written sample result (no model calls)' });
  await sleep(delayMs);
  emit({ demo, kind: 'vision', title: 'Reading FAX… (fixture transcription)', detail: 'In live mode this is the vision model on Token Factory.' });
  await sleep(delayMs * 2);
  emit({ demo, kind: 'vision', title: `Transcribed ${fx.vision.lines.length} lines`, data: fx.vision });
  await sleep(delayMs);
  emit({ demo, kind: 'info', title: 'Agent started (scripted fixture — in live mode: Nemotron tool-calling loop)' });
  for (const step of fx.script) {
    await sleep(delayMs);
    if (step.thought) emit({ demo, kind: 'thought', title: 'Agent (scripted)', detail: step.thought });
    const result = runTool(step.tool, step.args);
    emit({ demo, kind: 'tool', tool: step.tool, args: step.args, title: step.tool, detail: summarizeTool(step.tool, step.args, result) });
  }
  await sleep(delayMs);
  const res = finalizeOrder(fx.final);
  emit({ demo, kind: 'tool', tool: 'finalize_order', title: 'finalize_order', detail: summarizeTool('finalize_order', fx.final, res) });
  if (!res.ok) throw new Error(`fixture ${sampleId} failed validation: ${res.errors.join('; ')}`);
  return res.order;
}
