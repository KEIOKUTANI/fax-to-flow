// FAX to Flow — front end (no framework).
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yen = (n) => `¥${Number(n || 0).toLocaleString('ja-JP')}`;
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

const state = { config: null, products: new Map(), selected: null, job: null, order: null, lines: [], timer: null };

const STATUS = {
  confirmed: { icon: '✓', ja: '確定', en: 'confirmed' },
  needs_check: { icon: '⚠', ja: '要確認', en: 'needs check' },
  substitute: { icon: '↻', ja: '代替提案', en: 'substitute' },
};
const ICON = { vision: '👁', tool: '🔧', thought: '💭', info: 'ℹ', done: '✅', error: '⛔' };

async function init() {
  const [config, samples, products, stats] = await Promise.all(
    ['/api/config', '/api/samples', '/api/products', '/api/stats'].map((u) => fetch(u).then((r) => r.json())),
  );
  state.config = config;
  products.forEach((p) => state.products.set(p.sku, p));
  $('#demoBanner').hidden = config.mode !== 'demo';
  $('#models').innerHTML = `
    <span class="badge">Agent <b>${esc(config.llm_model)}</b></span>
    <span class="badge">Vision <b>${esc(config.vision_model)}</b></span>
    <span class="badge">${esc(config.base_url)}${config.mode === 'demo' ? ' · demo' : ''}</span>`;
  renderStats(stats);

  $('#samples').innerHTML = samples.map((s) => `
    <button class="sample" data-id="${esc(s.id)}" data-url="${esc(s.url)}" title="${esc(s.title)}">
      <img src="${esc(s.url)}" alt=""><span>${esc(s.title)}</span>
    </button>`).join('');
  $('#samples').addEventListener('click', (e) => {
    const b = e.target.closest('.sample');
    if (!b) return;
    selectInput({ sample: b.dataset.id, url: b.dataset.url });
  });

  const file = $('#file');
  const drop = $('#drop');
  file.addEventListener('change', () => file.files[0] && loadFile(file.files[0]));
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => e.dataTransfer.files[0] && loadFile(e.dataTransfer.files[0]));

  $('#run').addEventListener('click', run);
  $('#approve').addEventListener('click', approve);

  const want = new URLSearchParams(location.search).get('sample');
  if (want) {
    const b = document.querySelector(`.sample[data-id="${CSS.escape(want)}"]`);
    if (b) { selectInput({ sample: b.dataset.id, url: b.dataset.url }); if (new URLSearchParams(location.search).has('autorun')) run(); }
  }
}

function renderStats(s) {
  $('#savedNum').textContent = fmtTime(s.saved_seconds);
  $('#saved').title = `${s.orders} sheets approved · manual ${s.manual_seconds_per_sheet / 60} min/sheet vs agent ${s.agent_seconds}s total`;
}

function selectInput(sel) {
  state.selected = sel;
  document.querySelectorAll('.sample').forEach((b) => b.classList.toggle('on', b.dataset.id === sel.sample));
  $('#preview').innerHTML = `<img src="${sel.url}" alt="FAX image">`;
  $('#run').disabled = false;
}

async function loadFile(f) {
  // Downscale on the client so the upload (and the vision request) stays small.
  const img = await createImageBitmap(f);
  const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const keepOriginal = scale === 1 && f.size < 4e6;
  const url = keepOriginal ? await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(f); }) : c.toDataURL('image/jpeg', 0.85);
  selectInput({ image: url, url });
}

function addStep(e) {
  const feed = $('#feed');
  feed.querySelector('.idle')?.remove();
  const li = document.createElement('li');
  li.className = `k-${e.kind}`;
  li.dataset.icon = ICON[e.kind] || '•';
  const demoTag = e.demo ? '<span class="tagdemo">demo</span>' : '';
  let title = esc(e.title);
  if (e.kind === 'tool') title = `<code>${esc(e.tool)}</code>`;
  let html = `<div class="t">${title}${demoTag}</div>`;
  if (e.kind === 'tool' && e.args) html += `<div class="args">${esc(JSON.stringify(e.args))}</div>`;
  if (e.detail) html += `<div class="d">${esc(e.detail)}</div>`;
  if (e.data) html += `<details><summary>raw transcription JSON</summary><pre>${esc(JSON.stringify(e.data, null, 2))}</pre></details>`;
  li.innerHTML = html;
  feed.appendChild(li);
  feed.scrollTop = feed.scrollHeight;
}

async function run() {
  if (!state.selected) return;
  $('#run').disabled = true;
  $('#result').hidden = true;
  $('#done').hidden = true;
  $('#feed').innerHTML = '';
  const t0 = Date.now();
  clearInterval(state.timer);
  state.timer = setInterval(() => { $('#timer').textContent = `${((Date.now() - t0) / 1000).toFixed(1)}s`; }, 100);

  const body = state.selected.sample ? { sample: state.selected.sample } : { image: state.selected.image };
  const r = await fetch('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) {
    clearInterval(state.timer);
    addStep({ kind: 'error', title: 'Could not start', detail: j.error });
    $('#run').disabled = false;
    return;
  }
  state.job = j.id;
  const es = new EventSource(`/api/jobs/${j.id}/events`);
  es.onmessage = (m) => {
    const e = JSON.parse(m.data);
    addStep(e);
    if (e.kind === 'done' || e.kind === 'error') {
      es.close();
      clearInterval(state.timer);
      $('#timer').textContent = `${((Date.now() - t0) / 1000).toFixed(1)}s`;
      $('#run').disabled = false;
      if (e.kind === 'done') { state.seconds = e.seconds; showOrder(e.order); }
    }
  };
  es.onerror = () => { es.close(); clearInterval(state.timer); $('#run').disabled = false; };
}

function showOrder(order) {
  state.order = order;
  state.lines = order.lines.map((l) => ({ line_no: l.line_no, sku: l.sku, qty: l.qty, resolved: l.status !== 'needs_check' }));
  const c = order.customer;
  $('#cust').innerHTML = c
    ? `<b>${esc(c.company)}</b> ${esc(c.department || '')} ${esc(c.contact_honorific || '')}<br><small>${esc(c.company_en)} · FAX ${esc(c.fax)} · ${esc(c.id)}</small>`
    : '<span class="flag">顧客未特定 / customer not identified</span>';
  $('#summary').innerHTML = `${esc(order.summary_en || '')}${order.due_date ? ` <b>納期 / due:</b> ${esc(order.due_date)}` : ''}`;
  $('#replyJa').value = order.reply_ja;
  $('#replyEn').textContent = order.reply_en;
  renderLines();
  $('#result').hidden = false;
  $('#result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function productOptions(line, cur) {
  const skus = [...new Set([line.sku, ...(line.alternatives || []), line.original_sku].filter(Boolean))];
  return skus.map((s) => {
    const p = state.products.get(s);
    const tag = s === line.original_sku ? ` — ご注文品 (在庫 ${p?.stock ?? 0})` : s !== line.sku ? ' — 候補 / alternative' : '';
    return `<option value="${esc(s)}" ${s === cur ? 'selected' : ''}>${esc(s)} ${esc(p?.name_ja ?? '')}${esc(tag)}</option>`;
  }).join('') || '<option value="">(未特定 / unmatched)</option>';
}

function renderLines() {
  const tb = $('#lines');
  tb.innerHTML = state.order.lines.map((l, i) => {
    const st = state.lines[i];
    const p = state.products.get(st.sku);
    const s = STATUS[l.status];
    const conf = Math.round(l.confidence * 100);
    return `<tr class="${st.resolved ? 'resolved' : ''}" data-i="${i}">
      <td>${esc(l.line_no)}</td>
      <td class="raw">${esc(l.raw_text)}</td>
      <td>
        <select data-k="sku">${productOptions(l, st.sku)}</select>
        <div class="note">${esc(l.note_ja)}<span class="en">${esc(l.note_en)}</span></div>
        ${l.server_flags?.length ? `<div class="flag">server: ${esc(l.server_flags.join('; '))}</div>` : ''}
      </td>
      <td class="num"><input type="number" min="0" step="1" value="${esc(st.qty)}" data-k="qty"><span class="unit">${esc(p?.unit ?? '')}</span></td>
      <td class="num">${yen((p?.unit_price_jpy ?? 0) * st.qty)}<div class="note">@${yen(p?.unit_price_jpy ?? 0)}</div></td>
      <td><div class="conf ${conf < 80 ? 'mid' : ''}"><div class="bar"><i style="width:${conf}%"></i></div><span>${conf}%</span></div></td>
      <td><span class="chip ${l.status}">${s.icon} ${s.ja} <small>${s.en}</small></span>
        ${l.status === 'needs_check' ? `<button class="resolve" data-k="resolve">${st.resolved ? '確認済 ✓ checked' : '確認した / mark checked'}</button>` : ''}</td>
    </tr>`;
  }).join('');
  tb.querySelectorAll('[data-k]').forEach((el) => {
    const i = Number(el.closest('tr').dataset.i);
    const k = el.dataset.k;
    if (k === 'resolve') el.addEventListener('click', () => { state.lines[i].resolved = !state.lines[i].resolved; renderLines(); });
    else el.addEventListener('change', () => {
      state.lines[i][k] = k === 'qty' ? Math.max(0, Number(el.value) || 0) : el.value;
      if (k === 'sku') state.lines[i].resolved = true;
      renderLines();
    });
  });
  const total = state.lines.reduce((sum, st) => sum + (state.products.get(st.sku)?.unit_price_jpy ?? 0) * st.qty, 0);
  $('#total').textContent = yen(total);
  const open = state.lines.filter((x) => !x.resolved).length;
  $('#approve').disabled = open > 0;
  $('#approveHint').textContent = open ? `要確認 ${open}件 を確認してください — ${open} line(s) need a human check before approval` : '';
}

async function approve() {
  $('#approve').disabled = true;
  const r = await fetch(`/api/jobs/${state.job}/approve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lines: state.lines.map(({ line_no, sku, qty }) => ({ line_no, sku, qty })), reply_ja: $('#replyJa').value }),
  });
  const j = await r.json();
  if (!r.ok) { $('#approveHint').textContent = j.error; $('#approve').disabled = false; return; }
  renderStats(j.stats);
  const saved = Math.max(0, j.stats.manual_seconds_per_sheet - (state.seconds || 0));
  $('#done').hidden = false;
  $('#done').innerHTML = `
    <span class="big-n">✓ ${esc(j.order_id)}</span>
    <span>受注台帳に登録しました <small>written to the order ledger</small></span>
    <a href="${esc(j.reply_url)}" target="_blank" rel="noopener">返信FAXを開く <small>open reply FAX</small> →</a>
    <a href="/api/ledger.csv">台帳CSV <small>ledger CSV</small></a>
    <span><small>${j.stats.orders} sheets · ~${fmtTime(saved)} saved on this sheet vs ${j.stats.manual_seconds_per_sheet / 60} min manual entry</small></span>`;
}

init();
