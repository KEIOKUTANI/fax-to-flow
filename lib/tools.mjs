// The agent's tools: JSON-schema definitions (OpenAI "tools" format) + executors.
// The model decides which tools to call; the server only executes them and
// re-checks anything that touches money or stock (prices always come from the master).
import { customers, customerById, productBySku, products } from './store.mjs';
import { searchProducts, similarity } from './match.mjs';

const fn = (name, description, properties, required = Object.keys(properties)) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});

export const TOOL_SCHEMAS = [
  fn('lookup_customer', 'Identify the sending customer from the fax number in the fax header or from the company/contact name written on the sheet.', {
    fax_or_name: { type: 'string', description: 'Fax number (any format) or company / person name as written.' },
  }),
  fn('search_products', 'Fuzzy-search the product master for one order line. Pass the item name and spec exactly as the customer wrote it (abbreviations are fine). Returns ranked candidates with a 0-1 score and an "ambiguous" flag.', {
    query: { type: 'string', description: 'e.g. "六ボル M10-30" or "SUS六角ボルト M10×40"' },
  }),
  fn('check_stock', 'Check whether the requested quantity (in the product\'s sales unit) is in stock.', {
    sku: { type: 'string' },
    qty: { type: 'number' },
  }),
  fn('get_usual_order', 'Return the customer\'s usual order (their regular items and quantities). Use when the fax refers to "いつもの" / "the usual" / "same as last time".', {
    customer_id: { type: 'string' },
  }),
  fn('propose_substitute', 'Find in-stock substitutes for a product that is out of stock or short. Same category and thread size are preferred.', {
    sku: { type: 'string' },
    qty: { type: 'number', description: 'Quantity that needs to be covered.' },
  }, ['sku']),
  fn('finalize_order', 'Submit the structured order draft for human approval. Call exactly once, after all lines are resolved. Prices are filled in by the server from the master.', {
    customer_id: { type: 'string', description: 'Customer id from lookup_customer, or empty if unknown.' },
    due_date: { type: 'string', description: 'Requested delivery date, ISO yyyy-mm-dd if it can be inferred.' },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          line_no: { type: 'integer' },
          raw_text: { type: 'string', description: 'What the customer wrote for this line.' },
          sku: { type: 'string', description: 'Chosen SKU (the substitute SKU if status is substitute). Empty string if no product matches.' },
          qty: { type: 'number' },
          status: { type: 'string', enum: ['confirmed', 'needs_check', 'substitute'] },
          confidence: { type: 'number', description: '0-1' },
          original_sku: { type: 'string', description: 'For substitute lines: the SKU the customer asked for. Otherwise empty.' },
          alternatives: { type: 'array', items: { type: 'string' }, description: 'Other plausible SKUs for needs_check lines.' },
          note_ja: { type: 'string' },
          note_en: { type: 'string' },
        },
        required: ['line_no', 'raw_text', 'sku', 'qty', 'status', 'confidence'],
      },
    },
    reply_ja: { type: 'string', description: 'Polite Japanese (keigo) reply fax body to the customer confirming the order, mentioning any substitutes or questions.' },
    reply_en: { type: 'string', description: 'Faithful English gloss of reply_ja.' },
    summary_en: { type: 'string', description: 'One-sentence summary for the clerk.' },
  }, ['customer_id', 'lines', 'reply_ja', 'reply_en']),
];

const digits = (s) => String(s ?? '').normalize('NFKC').replace(/\D/g, '');

const productView = (p) => p && ({
  sku: p.sku, name_ja: p.name_ja, name_en: p.name_en, spec: p.spec, unit: p.unit, unit_price_jpy: p.unit_price_jpy,
});

function lookupCustomer({ fax_or_name }) {
  const d = digits(fax_or_name);
  if (d.length >= 9) {
    const hit = customers.find((c) => digits(c.fax) === d || digits(c.fax).endsWith(d.slice(-8)));
    if (hit) return { found: true, match: 'fax', confidence: 0.99, customer: publicCustomer(hit) };
  }
  const ranked = customers
    .map((c) => ({ c, s: Math.max(similarity(fax_or_name, c.company), similarity(fax_or_name, `${c.company}${c.contact}`)) }))
    .sort((a, b) => b.s - a.s);
  if (ranked[0].s >= 0.5) {
    return { found: true, match: 'name', confidence: Math.round(ranked[0].s * 100) / 100, customer: publicCustomer(ranked[0].c) };
  }
  return { found: false, candidates: ranked.slice(0, 3).map((r) => ({ id: r.c.id, company: r.c.company, score: Math.round(r.s * 100) / 100 })) };
}

const publicCustomer = (c) => ({
  id: c.id, company: c.company, company_en: c.company_en, type: c.type, fax: c.fax,
  department: c.department, contact_honorific: c.contact_honorific,
});

function searchProductsTool({ query }) {
  const ranked = searchProducts(products, query, 5);
  const candidates = ranked.map((r) => ({ ...productView(r.p), score: r.score, why: r.reasons.join(', ') }));
  // Ambiguous = runner-up is a plausible match and close to the winner (compared on uncapped scores).
  const ambiguous = ranked.length > 1 && ranked[0].raw - ranked[1].raw < 0.1 && ranked[1].score >= 0.6;
  return { query, ambiguous, candidates };
}

function checkStock({ sku, qty }) {
  const p = productBySku.get(sku);
  if (!p) return { error: `unknown sku ${sku}` };
  const n = Number(qty) || 0;
  return { sku, name_ja: p.name_ja, requested: n, unit: p.unit, in_stock: p.stock, available: p.stock >= n, shortfall: Math.max(0, n - p.stock) };
}

function getUsualOrder({ customer_id }) {
  const c = customerById.get(customer_id);
  if (!c) return { error: `unknown customer ${customer_id}` };
  return {
    customer_id, company: c.company, last_order: c.last_order,
    items: c.usual_items.map((u) => ({ ...productView(productBySku.get(u.sku)), qty: u.qty })),
  };
}

function proposeSubstitute({ sku, qty }) {
  const p = productBySku.get(sku);
  if (!p) return { error: `unknown sku ${sku}` };
  const need = Number(qty) || 1;
  const cands = products
    .filter((x) => x.sku !== sku && x.category === p.category && x.stock > 0)
    .map((x) => {
      let s = 0;
      const why = [];
      if (x.thread === p.thread) { s += 3; why.push('same size'); }
      if (x.material === p.material) { s += 2; why.push(p.material === 'sus' ? 'same material (SUS304)' : 'same material'); }
      if (x.length_mm && p.length_mm) {
        const d = x.length_mm - p.length_mm;
        s -= Math.abs(d) / 10;
        if (d !== 0) why.push(`${d > 0 ? '+' : ''}${d}mm length`);
      }
      if (x.stock >= need) s += 1; else why.push(`only ${x.stock} in stock`);
      return { ...productView(x), in_stock: x.stock, rank: s, why: why.join(', ') };
    })
    .sort((a, b) => b.rank - a.rank)
    .slice(0, 3)
    .map(({ rank, ...rest }) => rest);
  return { for_sku: sku, for_name_ja: p.name_ja, qty_needed: need, substitutes: cands };
}

/** Validate and price the model's order draft. Returns errors the model can fix. */
export function finalizeOrder(args) {
  const errors = [];
  const customer = customerById.get(args.customer_id) || null;
  if (args.customer_id && !customer) errors.push(`unknown customer_id ${args.customer_id}`);
  const lines = (args.lines || []).map((l, i) => {
    const p = l.sku ? productBySku.get(l.sku) : null;
    const status = ['confirmed', 'needs_check', 'substitute'].includes(l.status) ? l.status : 'needs_check';
    const qty = Math.max(0, Number(l.qty) || 0);
    const line = {
      line_no: l.line_no ?? i + 1,
      raw_text: l.raw_text || '',
      sku: p ? p.sku : null,
      name_ja: p?.name_ja ?? '(未特定 / unmatched)',
      name_en: p?.name_en ?? '',
      spec: p?.spec ?? '',
      unit: p?.unit ?? '',
      qty,
      unit_price_jpy: p?.unit_price_jpy ?? 0,
      amount_jpy: p ? p.unit_price_jpy * qty : 0,
      status,
      confidence: Math.max(0, Math.min(1, Number(l.confidence) || 0)),
      original_sku: l.original_sku && productBySku.has(l.original_sku) ? l.original_sku : null,
      alternatives: (l.alternatives || []).filter((s) => productBySku.has(s) && s !== (p && p.sku)),
      note_ja: l.note_ja || '',
      note_en: l.note_en || '',
      server_flags: [],
    };
    if (l.sku && !p) errors.push(`line ${line.line_no}: unknown sku ${l.sku}`);
    if (!p && status !== 'needs_check') { line.status = 'needs_check'; line.server_flags.push('no SKU → needs check'); }
    // Guardrail: never auto-confirm what we can't ship.
    if (p && p.stock < qty && line.status === 'confirmed') {
      line.status = 'needs_check';
      line.server_flags.push(`server stock check: only ${p.stock} in stock`);
    }
    if (line.status === 'substitute' && !line.original_sku) line.server_flags.push('substitute without original_sku');
    return line;
  });
  if (!lines.length) errors.push('order has no lines');
  if (!args.reply_ja) errors.push('reply_ja is empty');
  const order = {
    customer: customer && publicCustomer(customer),
    due_date: args.due_date || '',
    lines,
    total_jpy: lines.reduce((s, l) => s + l.amount_jpy, 0),
    reply_ja: args.reply_ja || '',
    reply_en: args.reply_en || '',
    summary_en: args.summary_en || '',
  };
  return { ok: errors.length === 0, errors, order };
}

const EXECUTORS = {
  lookup_customer: lookupCustomer,
  search_products: searchProductsTool,
  check_stock: checkStock,
  get_usual_order: getUsualOrder,
  propose_substitute: proposeSubstitute,
  finalize_order: finalizeOrder,
};

export const TOOL_NAMES = Object.keys(EXECUTORS);

export function runTool(name, args) {
  const exec = EXECUTORS[name];
  if (!exec) return { error: `unknown tool ${name}. Available: ${TOOL_NAMES.join(', ')}` };
  try {
    return exec(args || {});
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

/** One-line human summary of a tool call for the live step feed. */
export function summarizeTool(name, args, result) {
  if (result?.error) return `error: ${result.error}`;
  switch (name) {
    case 'lookup_customer':
      return result.found ? `${result.customer.company} (${result.customer.id}, by ${result.match})` : 'no match';
    case 'search_products': {
      const top = result.candidates.slice(0, 2).map((c) => `${c.sku} ${c.name_ja} (${c.score})`);
      return (result.ambiguous ? '⚠ ambiguous: ' : '') + (top.join(' / ') || 'no candidates');
    }
    case 'check_stock':
      return result.available ? `${result.in_stock} in stock ≥ ${result.requested} ✓` : `only ${result.in_stock} in stock (short ${result.shortfall})`;
    case 'get_usual_order':
      return result.items.map((i) => `${i.name_ja} ×${i.qty}`).join(', ');
    case 'propose_substitute':
      return result.substitutes.length ? result.substitutes.map((s) => `${s.sku} (${s.why})`).join(' / ') : 'no substitute in stock';
    case 'finalize_order':
      return result.ok ? `${result.order.lines.length} lines, ¥${result.order.total_jpy.toLocaleString()}` : `rejected: ${result.errors.join('; ')}`;
    default:
      return '';
  }
}
