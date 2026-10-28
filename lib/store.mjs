// Product master, customer master and the order ledger (CSV on disk).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');

export const products = JSON.parse(fs.readFileSync(path.join(DATA, 'products.json'), 'utf8'));
export const customers = JSON.parse(fs.readFileSync(path.join(DATA, 'customers.json'), 'utf8'));
export const productBySku = new Map(products.map((p) => [p.sku, p]));
export const customerById = new Map(customers.map((c) => [c.id, c]));

const LEDGER = process.env.LEDGER_PATH || path.join(DATA, 'orders.csv');
const APPROVED = path.join(path.dirname(LEDGER), 'approved-orders.json');
export const LEDGER_HEADER = [
  'order_id', 'approved_at', 'customer_id', 'customer_name', 'line_no', 'sku', 'name_ja', 'qty', 'unit',
  'unit_price_jpy', 'amount_jpy', 'line_status', 'due_date', 'mode', 'source',
];

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function ensureLedger() {
  if (!fs.existsSync(LEDGER) || fs.readFileSync(LEDGER, 'utf8').trim() === '') {
    fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
    fs.writeFileSync(LEDGER, LEDGER_HEADER.join(',') + '\n');
  }
}

// Approved orders (kept for the printable reply page). Persisted best-effort.
const approved = new Map();
try {
  for (const o of JSON.parse(fs.readFileSync(APPROVED, 'utf8'))) approved.set(o.order_id, o);
} catch { /* first run */ }

export function getApproved(id) {
  return approved.get(id);
}

export function listApproved() {
  return [...approved.values()].sort((a, b) => b.approved_at.localeCompare(a.approved_at));
}

export function nextOrderId() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const n = [...approved.keys()].filter((k) => k.includes(ymd)).length + 1;
  return `FTF-${ymd}-${String(n).padStart(3, '0')}`;
}

export function appendOrder(order) {
  ensureLedger();
  const rows = order.lines.map((l) => [
    order.order_id, order.approved_at, order.customer?.id ?? '', order.customer?.company ?? '', l.line_no, l.sku,
    l.name_ja, l.qty, l.unit, l.unit_price_jpy, l.amount_jpy, l.human_edited ? `${l.status}+edited` : l.status, order.due_date ?? '', order.mode, order.source,
  ].map(csvCell).join(','));
  fs.appendFileSync(LEDGER, rows.join('\n') + '\n');
  approved.set(order.order_id, order);
  try { fs.writeFileSync(APPROVED, JSON.stringify([...approved.values()], null, 1)); } catch { /* read-only fs */ }
}

export function readLedger() {
  ensureLedger();
  return fs.readFileSync(LEDGER, 'utf8');
}
