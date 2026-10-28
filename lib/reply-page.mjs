// Printable reply FAX (ご注文確認書) for an approved order. Server-rendered HTML, A4.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yen = (n) => `¥${Number(n || 0).toLocaleString('ja-JP')}`;

const STATUS_NOTE = {
  confirmed: '',
  needs_check: '要確認 / to confirm',
  substitute: '代替品 ご確認ください / substitute',
};

function jaDate(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return esc(iso);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

export function renderReplyPage(order) {
  const c = order.customer || {};
  const tax = Math.round(order.total_jpy * 0.1);
  const rows = order.lines.map((l, i) => `
      <tr>
        <td class="c">${i + 1}</td>
        <td class="mono">${esc(l.sku)}</td>
        <td>${esc(l.name_ja)}<div class="sub">${esc(l.spec)}</div></td>
        <td class="r">${esc(l.qty)} ${esc(l.unit)}</td>
        <td class="r">${yen(l.unit_price_jpy)}</td>
        <td class="r">${yen(l.amount_jpy)}</td>
        <td class="note">${esc(STATUS_NOTE[l.status] || '')}${l.status === 'substitute' && l.original_sku ? `<div class="sub">ご注文品: ${esc(l.original_sku)}</div>` : ''}</td>
      </tr>`).join('');

  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reply FAX ${esc(order.order_id)}</title>
<style>
  @page { size: A4; margin: 14mm; }
  :root { --ink:#111; --muted:#555; --line:#222; --paper:#fff; --bg:#e9e7e1; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font-family:"Hiragino Mincho ProN","Yu Mincho","IPAMincho","Noto Serif JP",serif; }
  .bar { position:sticky; top:0; display:flex; gap:12px; align-items:center; justify-content:center; flex-wrap:wrap; padding:10px 16px; background:#1d2b36; color:#fff; font:14px system-ui,sans-serif; }
  .bar button, .bar a { font:inherit; padding:6px 14px; border-radius:6px; border:0; background:#f2b84b; color:#1d2b36; cursor:pointer; text-decoration:none; }
  .bar label { display:flex; gap:6px; align-items:center; }
  .sheet { width:min(210mm, 100% - 32px); margin:20px auto 40px; background:var(--paper); padding:16mm 15mm; box-shadow:0 2px 14px rgba(0,0,0,.15); }
  .stamp { font:12px ui-monospace,monospace; color:var(--muted); border-bottom:1px solid #999; padding-bottom:4px; margin-bottom:18px; display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap; }
  h1 { text-align:center; letter-spacing:.5em; font-size:26px; margin:6px 0 2px; }
  .h1en { text-align:center; font:12px system-ui,sans-serif; color:var(--muted); margin-bottom:18px; }
  .head { display:flex; justify-content:space-between; gap:24px; flex-wrap:wrap; }
  .to .co { font-size:20px; border-bottom:1px solid var(--line); padding-bottom:2px; }
  .from { text-align:right; font-size:13px; line-height:1.6; }
  .from .co { font-size:16px; font-weight:bold; }
  .meta { margin:14px 0; font-size:13px; display:flex; gap:24px; flex-wrap:wrap; }
  .body { white-space:pre-wrap; line-height:1.85; font-size:14.5px; margin:14px 0 18px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { border:1px solid var(--line); padding:5px 6px; vertical-align:top; }
  th { background:#f1f1f1; font-weight:normal; }
  .c { text-align:center; } .r { text-align:right; white-space:nowrap; } .mono { font-family:ui-monospace,monospace; font-size:12px; white-space:nowrap; }
  .sub { font-size:11px; color:var(--muted); }
  .note { font-size:11.5px; }
  .tot td { border:none; text-align:right; padding:3px 6px; }
  .tot .v { width:120px; border-bottom:1px solid var(--line); }
  .ack { margin-top:22px; border:1px dashed var(--line); padding:10px 12px; font-size:13px; }
  .gloss { margin-top:22px; padding:12px 14px; background:#f6f6f2; border-left:3px solid #f2b84b; font:13px/1.6 system-ui,sans-serif; white-space:pre-wrap; }
  .gloss b { display:block; margin-bottom:4px; }
  .demo { font:11px system-ui,sans-serif; color:#a14; margin-top:8px; }
  .hide-gloss .gloss { display:none; }
  @media print { body { background:#fff; } .bar { display:none; } .sheet { box-shadow:none; margin:0; width:auto; padding:0; } }
</style></head>
<body>
<div class="bar">
  <span>Reply FAX preview · ${esc(order.order_id)}</span>
  <label><input type="checkbox" id="g" checked onchange="document.body.classList.toggle('hide-gloss',!this.checked)"> English gloss</label>
  <button onclick="print()">印刷 / Print</button>
  <a href="/">← Back</a>
</div>
<div class="sheet">
  <div class="stamp"><span>${jaDate(order.approved_at)} FROM: 06-6745-8800 YAMATO KANAMONO</span><span>TO: ${esc(c.fax || '')}</span><span>P.001/001</span></div>
  <h1>ご注文確認書</h1>
  <div class="h1en">Order confirmation (reply FAX)</div>
  <div class="head">
    <div class="to">
      <div class="co">${esc(c.company || 'お客様')} 御中</div>
      <div>${esc(c.department || '')} ${esc(c.contact_honorific || '')}</div>
      <div class="sub">FAX ${esc(c.fax || '')}</div>
    </div>
    <div class="from">
      <div>${jaDate(order.approved_at)}</div>
      <div class="co">大和金物株式会社</div>
      <div>営業部 受注係</div>
      <div>大阪府東大阪市高井田西 (架空 / fictional)</div>
      <div>TEL 06-6745-8811　FAX 06-6745-8800</div>
    </div>
  </div>
  <div class="meta"><span>受注番号: ${esc(order.order_id)}</span><span>納品予定日: ${order.due_date ? jaDate(order.due_date) : '別途ご連絡'}</span></div>
  <div class="body">${esc(order.reply_ja)}</div>
  <div style="text-align:center;margin:6px 0 10px">記</div>
  <table>
    <thead><tr><th>No</th><th>品番</th><th>品名・規格</th><th>数量</th><th>単価</th><th>金額</th><th>備考</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <table class="tot">
    <tr><td>小計</td><td class="v">${yen(order.total_jpy)}</td></tr>
    <tr><td>消費税 (10%)</td><td class="v">${yen(tax)}</td></tr>
    <tr><td><b>合計</b></td><td class="v"><b>${yen(order.total_jpy + tax)}</b></td></tr>
  </table>
  <div style="text-align:right;margin-top:8px">以上</div>
  ${order.lines.some((l) => l.status !== 'confirmed') ? `<div class="ack">お手数ですが、代替品・要確認の項目についてご承諾の可否をご記入の上、本紙にてご返信ください。<br>
    □ 承諾します　　□ 下記の通り変更をお願いします：＿＿＿＿＿＿＿＿＿＿＿＿　　ご署名：＿＿＿＿＿＿</div>` : ''}
  <div class="gloss"><b>English gloss (for reference, not sent)</b>${esc(order.reply_en)}${order.reply_edited ? '\n\n(Note: the clerk edited the Japanese text after the draft; this gloss reflects the original draft.)' : ''}</div>
  ${order.mode === 'demo' ? '<div class="demo">Demo mode — generated from a pre-written sample result, not a live model call.</div>' : ''}
</div>
</body></html>`;
}
