// FAX to Flow — zero-dependency Node server.
//   node server.mjs           (PORT defaults to 3000)
// Live mode when NEBIUS_API_KEY is set; otherwise demo mode with fixtures.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runAgent, transcribeFax } from './lib/agent.mjs';
import { replayFixture, sampleIdForImage, samples } from './lib/demo.mjs';
import { config, isLive } from './lib/llm.mjs';
import { renderReplyPage } from './lib/reply-page.mjs';
import { appendOrder, getApproved, listApproved, nextOrderId, productBySku, products, readLedger } from './lib/store.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const MANUAL_SECONDS_PER_SHEET = Number(process.env.MANUAL_SECONDS_PER_SHEET || 300);
const MAX_BODY = 12 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json',
};

// ---- jobs ------------------------------------------------------------------

const jobs = new Map();

function createJob({ source, mode }) {
  const job = {
    id: crypto.randomUUID().slice(0, 8), source, mode, status: 'running', events: [], listeners: new Set(),
    order: null, error: null, startedAt: Date.now(), finishedAt: null, approvedOrderId: null,
  };
  jobs.set(job.id, job);
  // keep memory bounded
  if (jobs.size > 200) jobs.delete(jobs.keys().next().value);
  return job;
}

function emit(job, event) {
  const e = { ts: Date.now(), ...event };
  job.events.push(e);
  for (const res of job.listeners) res.write(`data: ${JSON.stringify(e)}\n\n`);
}

async function runJob(job, { sampleId, imageDataUrl }) {
  const send = (e) => emit(job, e);
  try {
    let order;
    if (job.mode === 'demo') {
      order = await replayFixture(sampleId, send);
    } else {
      const transcription = await transcribeFax(imageDataUrl, send);
      order = await runAgent(transcription, send);
    }
    job.order = order;
    job.status = 'done';
    job.finishedAt = Date.now();
    const c = order.lines.reduce((acc, l) => ({ ...acc, [l.status]: (acc[l.status] || 0) + 1 }), {});
    emit(job, {
      kind: 'done', demo: job.mode === 'demo',
      title: `Matched ${order.lines.length} lines · ${c.confirmed || 0} confirmed · ${c.needs_check || 0} need check · ${c.substitute || 0} substitute`,
      detail: `${((job.finishedAt - job.startedAt) / 1000).toFixed(1)}s`,
      order, seconds: (job.finishedAt - job.startedAt) / 1000,
    });
  } catch (err) {
    job.status = 'error';
    job.error = String(err.message || err);
    job.finishedAt = Date.now();
    emit(job, { kind: 'error', title: 'Failed', detail: job.error });
  }
  for (const res of job.listeners) res.end();
  job.listeners.clear();
}

// ---- helpers -----------------------------------------------------------------

function send(res, status, body, headers = {}) {
  const isStr = typeof body === 'string' || Buffer.isBuffer(body);
  res.writeHead(status, { 'Content-Type': isStr ? 'text/plain; charset=utf-8' : 'application/json', ...headers });
  res.end(isStr ? body : JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('payload too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function serveFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

function safeJoin(base, rel) {
  const p = path.normalize(path.join(base, rel));
  return p.startsWith(base + path.sep) ? p : null;
}

function stats() {
  const orders = listApproved();
  const agentSeconds = orders.reduce((s, o) => s + (o.processing_seconds || 0), 0);
  const manualSeconds = orders.length * MANUAL_SECONDS_PER_SHEET;
  return {
    orders: orders.length,
    lines: orders.reduce((s, o) => s + o.lines.length, 0),
    manual_seconds_per_sheet: MANUAL_SECONDS_PER_SHEET,
    manual_seconds: manualSeconds,
    agent_seconds: Math.round(agentSeconds * 10) / 10,
    saved_seconds: Math.max(0, Math.round(manualSeconds - agentSeconds)),
  };
}

// ---- routes ------------------------------------------------------------------

async function handleCreateJob(req, res) {
  const body = await readJson(req);
  let sampleId = body.sample || null;
  let imageDataUrl = body.image || null;
  if (sampleId && !samples.find((s) => s.id === sampleId)) return send(res, 400, { error: 'unknown sample' });

  if (imageDataUrl) {
    const m = /^data:(image\/(png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(imageDataUrl);
    if (!m) return send(res, 400, { error: 'image must be a base64 data URL (png/jpeg/webp)' });
    if (!isLive()) sampleId = sampleIdForImage(Buffer.from(m[3], 'base64'));
  } else if (sampleId && isLive()) {
    const s = samples.find((x) => x.id === sampleId);
    imageDataUrl = `data:image/png;base64,${fs.readFileSync(path.join(ROOT, 'samples', s.file)).toString('base64')}`;
  }

  if (!isLive() && !sampleId) {
    return send(res, 400, { error: 'Demo mode (no NEBIUS_API_KEY): only the three bundled samples can be processed. Set NEBIUS_API_KEY to read your own FAX images.' });
  }
  if (!sampleId && !imageDataUrl) return send(res, 400, { error: 'send {sample} or {image}' });

  const job = createJob({ source: sampleId || 'upload', mode: isLive() ? 'live' : 'demo' });
  runJob(job, { sampleId, imageDataUrl });
  send(res, 201, { id: job.id, mode: job.mode });
}

function handleEvents(req, res, job) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  for (const e of job.events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  if (job.status !== 'running') return res.end();
  job.listeners.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { clearInterval(ping); job.listeners.delete(res); });
}

async function handleApprove(req, res, job) {
  if (job.status !== 'done' || !job.order) return send(res, 409, { error: 'job not finished' });
  if (job.approvedOrderId) return send(res, 200, { order_id: job.approvedOrderId, reply_url: `/reply/${job.approvedOrderId}`, stats: stats() });
  const body = await readJson(req);
  const edits = new Map((body.lines || []).map((l) => [Number(l.line_no), l]));
  const lines = job.order.lines.map((l) => {
    const e = edits.get(Number(l.line_no)) || {};
    const p = productBySku.get(e.sku || l.sku);
    const qty = e.qty !== undefined ? Math.max(0, Number(e.qty) || 0) : l.qty;
    const edited = (e.sku && e.sku !== l.sku) || qty !== l.qty;
    return {
      ...l,
      sku: p?.sku ?? l.sku, name_ja: p?.name_ja ?? l.name_ja, name_en: p?.name_en ?? l.name_en, spec: p?.spec ?? l.spec,
      unit: p?.unit ?? l.unit, unit_price_jpy: p?.unit_price_jpy ?? 0, qty, amount_jpy: (p?.unit_price_jpy ?? 0) * qty,
      human_edited: Boolean(edited),
    };
  }).filter((l) => l.qty > 0 && l.sku);
  if (!lines.length) return send(res, 400, { error: 'no lines with a product and quantity' });

  const replyJa = typeof body.reply_ja === 'string' && body.reply_ja.trim() ? body.reply_ja : job.order.reply_ja;
  const order = {
    order_id: nextOrderId(),
    approved_at: new Date().toISOString(),
    customer: job.order.customer,
    due_date: job.order.due_date,
    lines,
    total_jpy: lines.reduce((s, l) => s + l.amount_jpy, 0),
    reply_ja: replyJa,
    reply_en: job.order.reply_en,
    reply_edited: replyJa !== job.order.reply_ja,
    summary_en: job.order.summary_en,
    mode: job.mode,
    source: job.source,
    processing_seconds: (job.finishedAt - job.startedAt) / 1000,
  };
  appendOrder(order);
  job.approvedOrderId = order.order_id;
  send(res, 201, { order_id: order.order_id, reply_url: `/reply/${order.order_id}`, stats: stats() });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && p === '/') return serveFile(res, path.join(ROOT, 'public', 'index.html'));
    if (req.method === 'GET' && p === '/healthz') return send(res, 200, 'ok');
    if (req.method === 'GET' && p === '/api/config') {
      return send(res, 200, {
        mode: isLive() ? 'live' : 'demo', llm_model: config.llmModel, vision_model: config.visionModel || (isLive() ? 'auto (picked on first FAX)' : 'Qwen/Qwen2-VL-72B-Instruct'),
        base_url: new URL(config.baseUrl).host, manual_seconds_per_sheet: MANUAL_SECONDS_PER_SHEET,
      });
    }
    if (req.method === 'GET' && p === '/api/samples') return send(res, 200, samples.map(({ sha256, ...s }) => s));
    if (req.method === 'GET' && p === '/api/stats') return send(res, 200, stats());
    if (req.method === 'GET' && p === '/api/products') return send(res, 200, products.map((x) => ({ sku: x.sku, name_ja: x.name_ja, name_en: x.name_en, spec: x.spec, unit: x.unit, unit_price_jpy: x.unit_price_jpy, stock: x.stock })));
    if (req.method === 'GET' && p === '/api/orders') return send(res, 200, listApproved().map((o) => ({ order_id: o.order_id, approved_at: o.approved_at, customer: o.customer?.company, lines: o.lines.length, total_jpy: o.total_jpy, mode: o.mode })));
    if (req.method === 'GET' && p === '/api/ledger.csv') {
      return send(res, 200, '﻿' + readLedger(), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="orders.csv"' });
    }
    if (req.method === 'POST' && p === '/api/jobs') return await handleCreateJob(req, res);

    const jm = p.match(/^\/api\/jobs\/([\w-]+)(\/events|\/approve)?$/);
    if (jm) {
      const job = jobs.get(jm[1]);
      if (!job) return send(res, 404, { error: 'job not found' });
      if (req.method === 'GET' && jm[2] === '/events') return handleEvents(req, res, job);
      if (req.method === 'POST' && jm[2] === '/approve') return await handleApprove(req, res, job);
      if (req.method === 'GET' && !jm[2]) {
        return send(res, 200, { id: job.id, status: job.status, mode: job.mode, events: job.events, order: job.order, error: job.error, approved_order_id: job.approvedOrderId });
      }
    }

    const rm = p.match(/^\/reply\/([\w-]+)$/);
    if (req.method === 'GET' && rm) {
      const order = getApproved(rm[1]);
      if (!order) return send(res, 404, 'Order not found (approved orders are kept on the server; it may have restarted).');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(renderReplyPage(order));
    }

    if (req.method === 'GET' && p.startsWith('/samples/')) {
      const f = safeJoin(path.join(ROOT, 'samples'), p.slice('/samples/'.length));
      return f ? serveFile(res, f) : send(res, 404, 'not found');
    }
    if (req.method === 'GET') {
      const f = safeJoin(path.join(ROOT, 'public'), p.slice(1));
      if (f) return serveFile(res, f);
    }
    send(res, 404, { error: 'not found' });
  } catch (err) {
    send(res, err.status || 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`FAX to Flow on http://localhost:${PORT}  [${isLive() ? `LIVE · agent ${config.llmModel} · vision ${config.visionModel}` : 'DEMO MODE — no NEBIUS_API_KEY, fixture playback'}]`);
});
