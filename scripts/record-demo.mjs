// Records the 3-minute demo video with burned-in English captions (no narration needed).
//   1. start the app:   node --env-file=.env server.mjs   (live)  or  node server.mjs  (demo)
//   2. record:          node scripts/record-demo.mjs [--url http://localhost:3000] [--out demo-video]
// Needs Playwright (npx playwright install chromium) and ffmpeg. Writes <out>/fax-to-flow-demo.mp4.
// Start from an empty ledger so the time-saved counter begins at 0:00.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)('playwright'); // CJS lookup also honours NODE_PATH / global installs

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const BASE = arg('url', 'http://localhost:3000').replace(/\/$/, '');
const OUT = path.resolve(arg('out', 'demo-video'));
const W = 1440, H = 900;
fs.mkdirSync(OUT, { recursive: true });

const config = await fetch(`${BASE}/api/config`).then((r) => r.json());
const demo = config.mode === 'demo';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: OUT, size: { width: W, height: H } } });
const page = await context.newPage();

// Caption bar and an always-visible mode tag, re-injected after every navigation.
async function overlay() {
  await page.evaluate(({ demo }) => {
    if (document.getElementById('rec-cap')) return;
    const cap = document.createElement('div');
    cap.id = 'rec-cap';
    cap.style.cssText = 'pointer-events:none;position:fixed;left:50%;bottom:28px;transform:translateX(-50%);max-width:1180px;padding:14px 26px;border-radius:12px;background:rgba(10,12,20,.86);color:#fff;font:600 26px/1.35 system-ui,sans-serif;text-align:center;z-index:99999;opacity:0;transition:opacity .25s';
    document.body.appendChild(cap);
    if (demo) {
      const tag = document.createElement('div');
      tag.style.cssText = 'pointer-events:none;position:fixed;top:10px;right:12px;padding:4px 10px;border-radius:6px;background:#b45309;color:#fff;font:600 13px system-ui;z-index:99999';
      tag.textContent = 'Demo mode: replayed agent run (no live model call)';
      document.body.appendChild(tag);
    }
  }, { demo });
}
async function say(text, ms = 4000) {
  await overlay();
  await page.evaluate((t) => { const c = document.getElementById('rec-cap'); c.textContent = t; c.style.opacity = t ? 1 : 0; }, text);
  if (ms) await wait(ms);
}
async function card(title, sub, ms) {
  await page.setContent(`<body style="margin:0;height:100vh;display:grid;place-items:center;background:#0f172a;color:#f8fafc;font-family:system-ui,sans-serif;text-align:center">
    <div><div style="font-size:64px;font-weight:800">${title}</div><div style="margin-top:22px;font-size:28px;color:#cbd5e1;line-height:1.5">${sub}</div></div></body>`);
  if (ms) await wait(ms);
}
async function runSample(id) {
  await page.goto(`${BASE}/?sample=${id}`);
  await overlay();
  await page.click('#run');
  await page.waitForSelector('#result:not([hidden])', { timeout: 180000 });
}

// 1. Hook
await card('Japan, 2026. Still FAX.', 'Small wholesalers still take most orders on paper.', 0);
await say('Every morning, a clerk re-types every FAX order by hand. About 5 minutes per sheet.', 6000);

// 2. The messy sheet
await page.goto(`${BASE}/?sample=sample2_messy`);
await say('Shorthand like 「六ボル」, a crossed-out quantity, an out-of-stock bolt, and a vague 「ワッシャー M10」.', 7000);
await page.hover('#models');
await say(`FAX to Flow is an order-desk agent. The brain: ${config.llm_model} on Nebius Token Factory.`, 6000);

// 3. Agent run
await say('A vision model only transcribes. Nemotron decides, step by step, with tool calls.', 0);
await page.click('#run');
await wait(3000);
await say('It identifies the customer, matches each line to the product master, and checks stock.', 0);
await page.waitForSelector('#result:not([hidden])', { timeout: 180000 });
await say('The stainless bolt is out of stock, so it proposes a substitute in the same material.', 5000);

// 4. Human in control
await page.locator('#result').scrollIntoViewIfNeeded();
await say('Every line gets a status and a confidence score. Uncertain lines are flagged, never guessed.', 6000);
const washer = page.locator('#lines tr', { hasText: 'ワッシャー' }).filter({ has: page.locator('.chip.needs_check') }).first();
if (await washer.count()) {
  const opts = await washer.locator('select option').allTextContents();
  const spring = opts.find((t) => t.includes('スプリング'));
  if (spring) await washer.locator('select').selectOption({ label: spring });
}
await say('The clerk picks the right washer. Approval stays locked until every flagged line is checked.', 4000);
for (let i = 0; i < 6; i++) {
  const btn = page.locator('#lines button.resolve', { hasText: 'mark checked' }).first();
  if (!(await btn.count())) break;
  await btn.click();
  await wait(600);
}

// 5. Reply draft
await page.locator('#replyJa').scrollIntoViewIfNeeded();
await say('Nemotron also drafts the reply FAX in polite business Japanese, with an English gloss.', 7000);

// 6. Approve
await page.locator('#approve').scrollIntoViewIfNeeded();
await say('Approve: the order goes into the ledger, and the reply FAX is ready to print.', 0);
await page.click('#approve');
await page.waitForSelector('#done:not([hidden])');
await wait(3000);
const replyUrl = await page.locator('#done a').first().getAttribute('href');
await page.goto(new URL(replyUrl, BASE).href);
await say('The printable reply FAX: order confirmation, substitute proposal, and a question about anything unclear.', 6000);

// 7. "The usual, doubled"
await page.goto(`${BASE}/?sample=sample3_usual`);
await say('Another sheet just says 「いつもの分、今回は倍で」: "the usual, doubled this time".', 5000);
await page.click('#run');
await page.waitForSelector('#result:not([hidden])', { timeout: 180000 });
await page.locator('#result').scrollIntoViewIfNeeded();
await say("It pulls the customer's order history, doubles it, and splits a line that is short on stock.", 7000);

// 8. Architecture + end
await card('How it works', 'FAX image → vision model (transcribe only) → <b>Nemotron agent loop</b>, 6 tools<br>→ server guardrails (prices from master, stock re-check) → human approval<br>→ ledger CSV + reply FAX', 0);
await say('Nemotron plans and decides. The server checks prices and stock. A human approves.', 8000);
await card('FAX to Flow', 'Keep the FAX machine. Lose the re-typing.<br><br>From ~5 minutes to seconds per sheet.', 6000);

const video = page.video();
await context.close();
await browser.close();
const webm = await video.path();
const mp4 = path.join(OUT, 'fax-to-flow-demo.mp4');
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23', mp4]);
fs.rmSync(webm);
const secs = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4]).toString());
console.log(`${mp4}  ${secs.toFixed(1)}s  (${demo ? 'demo' : 'live'} mode)${secs > 180 ? '  WARNING: over 3:00' : ''}`);
