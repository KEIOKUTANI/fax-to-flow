// Fuzzy matching for hand-written Japanese order lines.
//
// Customers write things like "六ボル M10-30", "SUSﾅｯﾄ M10" or "ワッシャー M10".
// We normalise both sides (NFKC, katakana, dimension separators, common trade
// shorthand), then blend a character-bigram score with structured attribute
// checks (thread size, length, material) so that "M10" never matches an M8 part.

const SHORTHAND = [
  // [pattern, canonical]  — order matters (longest first)
  [/ステンレス|ステン|すてん|sus304|sus/g, 'ステンレス'],
  [/六ボル|ろくぼる|ロクボル|6角ボルト|ろっかくぼると/g, '六角ボルト'],
  [/六ナット|6角ナット/g, '六角ナット'],
  [/キャップボルト|キャップスクリュー|キャップ|cap/g, '六角穴付きボルト'],
  [/六角穴付ボルト/g, '六角穴付きボルト'],
  [/平座金|丸ワッシャー|ヒラワ|ひらわっしゃー/g, '平ワッシャー'],
  [/ばね座金|バネ座金|スプワ|スプリングワッシャ(?!ー)/g, 'スプリングワッシャー'],
  [/ワッシャ(?!ー)|わっしゃー|座金/g, 'ワッシャー'],
  [/コーススレ(?!ッド)|コース(?!スレッド)/g, 'コーススレッド'],
  [/全ネジ|全ねじボルト|ズンギリ|寸切(?!り)/g, '寸切りボルト'],
  [/テックス|テクス|ドリルビス|ドリルネジ/g, 'ドリルねじ'],
  [/ネジ/g, 'ねじ'],
];

const toKatakana = (s) => s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));

export function normalize(input) {
  let s = String(input ?? '').normalize('NFKC').toLowerCase();
  s = s.replace(/[×✕＊*xX]/g, 'x');
  // "m10-30" / "m10 x 30" / "m10x30l" → "m10x30"
  s = s.replace(/m\s*(\d+(?:\.\d+)?)\s*[-−ーｰ~〜]\s*(\d+)/g, 'm$1x$2');
  s = s.replace(/(\d)\s*x\s*(\d)/g, '$1x$2');
  s = s.replace(/(m\d+x\d+)l\b/g, '$1');
  s = toKatakana(s);
  for (const [re, rep] of SHORTHAND) s = s.replace(re, rep);
  s = s.replace(/ステンレスステンレス/g, 'ステンレス');
  s = s.replace(/[\s・,、。()（）「」/／:：]/g, '');
  return s;
}

export function extractAttrs(norm) {
  const attrs = {};
  const thread = norm.match(/m(\d+(?:\.\d+)?)/);
  if (thread) attrs.thread = `M${thread[1]}`;
  const len = norm.match(/m\d+(?:\.\d+)?x(\d+)/) || norm.match(/(?:^|[^\d.])(\d\.\d)x(\d+)/);
  if (len) attrs.length = Number(len[2] ?? len[1]);
  const screw = norm.match(/(?:^|[^\d.m])(\d\.\d|\d)x(\d+)/);
  if (screw && !attrs.thread) {
    attrs.screwDia = screw[1];
    attrs.length = Number(screw[2]);
  }
  attrs.sus = norm.includes('ステンレス');
  return attrs;
}

function bigrams(s) {
  const out = new Map();
  if (s.length === 1) out.set(s, 1);
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}

/** Blend of query-coverage and Dice: tolerant of extra words on the catalogue side. */
function textScore(q, c) {
  if (!q || !c) return 0;
  if (q === c) return 1;
  const a = bigrams(q);
  const b = bigrams(c);
  let overlap = 0;
  let na = 0;
  let nb = 0;
  for (const v of a.values()) na += v;
  for (const v of b.values()) nb += v;
  for (const [g, v] of a) overlap += Math.min(v, b.get(g) || 0);
  const coverage = overlap / na;
  const dice = (2 * overlap) / (na + nb);
  return 0.6 * coverage + 0.4 * dice;
}

function prepareProduct(p) {
  if (p._norm) return p._norm;
  const texts = [p.name_ja, p.name_en, `${p.name_ja}${p.spec}`, ...(p.aliases || [])].map(normalize);
  p._norm = { texts, sku: normalize(p.sku) };
  return p._norm;
}

export function scoreProduct(query, product) {
  const q = normalize(query);
  const attrs = extractAttrs(q);
  const prep = prepareProduct(product);
  if (q === prep.sku) return { score: 1, raw: 2, reasons: ['exact SKU'] };

  // Compare on the "name" part only, so dimensions don't dominate the text score.
  const qName = q.replace(/m\d+(?:\.\d+)?(x\d+)?/g, '').replace(/\d+(\.\d+)?x\d+/g, '').replace(/\d+(箱|本|個|袋|枚|mm)?/g, '');
  let text = 0;
  for (const t of prep.texts) {
    const tName = t.replace(/m\d+(?:\.\d+)?(x\d+)?/g, '').replace(/\d+(\.\d+)?x\d+/g, '').replace(/\d+(箱|本|個|袋|枚|mm|本入|個入|枚入)?/g, '');
    text = Math.max(text, qName ? textScore(qName, tName) : 0, textScore(q, t) * 0.9);
  }

  const reasons = [];
  let adj = 0;
  if (attrs.thread) {
    if (product.thread === attrs.thread) { adj += 0.2; reasons.push(`thread ${attrs.thread} ✓`); }
    else if (product.thread) { adj -= 0.45; reasons.push(`thread ${product.thread} ≠ ${attrs.thread}`); }
  }
  if (attrs.screwDia && product.thread) {
    if (product.thread === attrs.screwDia) adj += 0.15;
    else adj -= 0.3;
  }
  if (attrs.length && product.length_mm) {
    if (product.length_mm === attrs.length) { adj += 0.12; reasons.push(`length ${attrs.length} ✓`); }
    else { adj -= 0.2; reasons.push(`length ${product.length_mm} ≠ ${attrs.length}`); }
  }
  if (attrs.sus && product.material === 'sus') { adj += 0.1; reasons.push('stainless ✓'); }
  else if (attrs.sus && product.material !== 'sus') { adj -= 0.2; reasons.push('not stainless'); }
  else if (!attrs.sus && product.material === 'sus') adj -= 0.15;

  const raw = Math.max(0, text * 0.8 + adj); // can exceed 1 when every attribute matches
  return { score: Math.round(Math.min(1, raw) * 100) / 100, raw, reasons };
}

export function searchProducts(products, query, limit = 5) {
  const ranked = products
    .map((p) => ({ p, ...scoreProduct(query, p) }))
    .filter((r) => r.score > 0.15)
    .sort((a, b) => b.raw - a.raw)
    .slice(0, limit);
  return ranked;
}

/** Simple string similarity for customer names. */
export function similarity(a, b) {
  return textScore(normalize(a), normalize(b));
}
