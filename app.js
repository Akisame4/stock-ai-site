'use strict';
/*
 * 株AI チェック — Stock_AI_log（非公開）を GitHub API で読むだけの静的サイト。
 * データはこのリポジトリに一切入れない。鍵は localStorage にだけ保存する。
 */

const OWNER = 'Akisame4';
const REPO = 'Stock_AI_log';
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const TOKEN_KEY = 'stockai.token';
const MANUAL_KEY = 'stockai.manualPrices';
const TAB_KEY = 'stockai.tab';
const EMPTY_TEXT = 'データがたまるとここに出るよ';

const WATCHLIST = [
  { ticker: '3397', name: 'トリドールHD' },
  { ticker: '3835', name: 'イーベース' },
  { ticker: '9202', name: 'ANAホールディングス' },
];

const $ = (id) => document.getElementById(id);

const state = {
  predictions: [],
  results: [],
  notes: '',
  prices: {},      // { '7203': { price, date } }
  pricesDate: '',
  trades: [],
  loaded: false,
};

/* ---------- storage (localStorage は失敗しうる) ---------- */
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } }
function lsDel(k) { try { localStorage.removeItem(k); } catch { /* noop */ } }
function getToken() { return (lsGet(TOKEN_KEY) || '').trim(); }
function getManualPrices() {
  try { return JSON.parse(lsGet(MANUAL_KEY) || '{}') || {}; } catch { return {}; }
}
function setManualPrice(ticker, price) {
  const m = getManualPrices();
  if (price == null) delete m[ticker]; else m[ticker] = price;
  lsSet(MANUAL_KEY, JSON.stringify(m));
}

/* ---------- helpers ---------- */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function normTicker(t) { return String(t ?? '').trim().toUpperCase().replace(/\.T$/, ''); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function fmtYen(n) {
  if (n == null) return '—';
  return n.toLocaleString('ja-JP', { maximumFractionDigits: 2 }) + '円';
}
function fmtPct(n, digits = 1) {
  if (n == null) return '—';
  return (n > 0 ? '+' : '') + n.toFixed(digits) + '%';
}
function fmtDate(s) {
  if (!s) return '';
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${Number(m[2])}/${Number(m[3])}` : String(s);
}
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function emptyBox(extra) {
  return `<div class="empty">${EMPTY_TEXT}${extra ? `<br><span class="small">${esc(extra)}</span>` : ''}</div>`;
}
function b64ToUtf8(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}
function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function parseJsonl(text) {
  const out = [];
  let bad = 0;
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try { const o = JSON.parse(t); if (o && typeof o === 'object') out.push(o); else bad++; } catch { bad++; }
  }
  return { rows: out, bad };
}

/* ---------- GitHub API ---------- */
class ApiError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}
async function gh(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    cache: 'no-store',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${getToken()}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    let m = '';
    try { m = (await res.json()).message || ''; } catch { /* noop */ }
    throw new ApiError(res.status, m || res.statusText);
  }
  return res.status === 204 ? null : res.json();
}
/** ファイルを読む。無ければ null。{ text, sha } */
async function readFile(path) {
  try {
    const j = await gh(`/contents/${encodeURIComponent(path)}?t=${Date.now()}`);
    if (Array.isArray(j) || j.type !== 'file') return null;
    let text;
    if (j.content && j.encoding === 'base64') {
      text = b64ToUtf8(j.content);
    } else {
      // 1MB を超えると content が空で返るので blob から読む
      const blob = await gh(`/git/blobs/${j.sha}`);
      text = b64ToUtf8(blob.content);
    }
    return { text, sha: j.sha };
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}
function explainError(e) {
  if (e instanceof ApiError) {
    if (e.status === 401) return '鍵が使えないみたい（期限切れか打ち間違い）。🔑から入れ直してね。';
    if (e.status === 403) return '鍵に権限が足りないか、回数制限にかかりました。少し待つか、鍵の権限を確認してね。';
    if (e.status === 404) return 'Stock_AI_log が見つからないよ。鍵の「対象リポジトリ」に Stock_AI_log が入っているか確認してね。';
    return `GitHub からエラー（${e.status}）: ${e.message}`;
  }
  return '通信できませんでした。電波を確認して ↻ で読み直してね。';
}

/* ---------- データ整形 ---------- */
function normalizePrices(obj) {
  const out = {};
  let date = '';
  if (!obj || typeof obj !== 'object') return { out, date };
  date = obj.updated_at || obj.date || obj.as_of || '';
  let src = obj.prices && typeof obj.prices === 'object' ? obj.prices : obj;
  if (Array.isArray(src)) {
    for (const r of src) {
      const t = normTicker(r.ticker || r.code);
      const p = num(r.price ?? r.close);
      if (t && p != null) out[t] = { price: p, date: r.date || date };
    }
    return { out, date };
  }
  for (const [k, v] of Object.entries(src)) {
    const t = normTicker(k);
    if (!/^[0-9A-Z]{3,6}$/.test(t)) continue;
    if (typeof v === 'number' || typeof v === 'string') {
      const p = num(v);
      if (p != null) out[t] = { price: p, date };
    } else if (v && typeof v === 'object') {
      const p = num(v.price ?? v.close);
      if (p != null) out[t] = { price: p, date: v.date || date, name: v.name };
    }
  }
  return { out, date };
}

function resultsById() {
  const m = new Map();
  for (const r of state.results) if (r.id) m.set(r.id, r);
  return m;
}
/** 判定済み（void を除く）結果を予想とくっつけて返す */
function scoredPairs() {
  const pm = new Map(state.predictions.map((p) => [p.id, p]));
  const out = [];
  for (const r of state.results) {
    if (r.hit !== true && r.hit !== false) continue; // void など
    const p = pm.get(r.id);
    out.push({ p, r });
  }
  return out;
}
function latestPredictionFor(ticker) {
  const t = normTicker(ticker);
  const list = state.predictions.filter((p) => normTicker(p.ticker) === t);
  if (!list.length) return null;
  list.sort((a, b) => String(b.predicted_at || '').localeCompare(String(a.predicted_at || '')));
  return list[0];
}
function nameFor(ticker) {
  const t = normTicker(ticker);
  const w = WATCHLIST.find((x) => x.ticker === t);
  if (w) return w.name;
  const p = latestPredictionFor(t);
  if (p && p.name) return p.name;
  const tr = [...state.trades].reverse().find((x) => normTicker(x.ticker) === t && x.name);
  if (tr) return tr.name;
  if (state.prices[t] && state.prices[t].name) return state.prices[t].name;
  return '';
}
function currentPrice(ticker) {
  const t = normTicker(ticker);
  if (state.prices[t]) return { price: state.prices[t].price, src: 'file', date: state.prices[t].date };
  const m = getManualPrices()[t];
  if (m != null && num(m) != null) return { price: num(m), src: 'manual' };
  return null;
}
/**
 * 予想から 買い・様子見・売り の割合を出す。
 * probs（buy/hold/sell）が記録されていればそれを使う。
 * 無ければ 2択（ベンチに勝つ=up / 負ける=down）の確信度をそのまま割り振る（様子見は 0）。
 */
function probsOf(p) {
  const pr = p && p.probs;
  if (pr && typeof pr === 'object') {
    const b = num(pr.buy), h = num(pr.hold), s = num(pr.sell);
    if (b != null && h != null && s != null && b + h + s > 0) {
      const sum = b + h + s;
      return { buy: (b / sum) * 100, hold: (h / sum) * 100, sell: (s / sum) * 100, binary: false };
    }
  }
  const c = num(p && p.confidence);
  if (c == null || (p.direction !== 'up' && p.direction !== 'down')) return null;
  return p.direction === 'up'
    ? { buy: c, hold: 0, sell: 100 - c, binary: true }
    : { buy: 100 - c, hold: 0, sell: c, binary: true };
}
function dirBadge(p) {
  if (!p) return '<span class="badge none">予想なし</span>';
  if (p.direction === 'up') return '<span class="badge up">TOPIXに勝つ予想</span>';
  if (p.direction === 'down') return '<span class="badge down">TOPIXに負ける予想</span>';
  return '<span class="badge none">向き不明</span>';
}
function trackLabel(t) { return t === '30d' ? '30日' : t === '7d' ? '1週間' : (t || ''); }

/* ---------- 描画: ダッシュボード ---------- */
function renderStats() {
  const nPred = state.predictions.length;
  const pairs = scoredPairs();
  const hits = pairs.filter((x) => x.r.hit === true).length;
  if (!nPred && !pairs.length) {
    $('statsBox').innerHTML = `<div class="stats">
      <div class="stat"><div class="v">0</div><div class="l">予想の数</div></div>
      <div class="stat"><div class="v">—</div><div class="l">答え合わせ済み</div></div>
      <div class="stat"><div class="v">—</div><div class="l">的中率</div></div>
    </div><div class="empty" style="margin-top:8px">${EMPTY_TEXT}</div>`;
    return;
  }
  const rate = pairs.length ? `${Math.round((hits / pairs.length) * 100)}%` : '—';
  let trackHtml = '';
  const tracks = ['30d', '7d'].map((t) => {
    const ps = pairs.filter((x) => x.p && x.p.track === t);
    if (!ps.length) return null;
    const h = ps.filter((x) => x.r.hit).length;
    return `${trackLabel(t)}予想 ${h}/${ps.length}（${Math.round((h / ps.length) * 100)}%）`;
  }).filter(Boolean);
  if (tracks.length) trackHtml = `<p class="track-line">内訳: ${esc(tracks.join(' ・ '))}</p>`;
  $('statsBox').innerHTML = `<div class="stats">
      <div class="stat"><div class="v">${nPred}</div><div class="l">予想の数</div></div>
      <div class="stat"><div class="v">${pairs.length}</div><div class="l">答え合わせ済み</div></div>
      <div class="stat"><div class="v">${rate}</div><div class="l">的中率</div></div>
    </div>${trackHtml}
    ${pairs.length ? '' : '<p class="track-line">答え合わせがまだなので的中率は出せません。</p>'}`;
}

function predCard(p) {
  const pr = probsOf(p);
  let bar = '';
  if (pr) {
    const seg = (cls, v, label) => v > 0 ? `<div class="${cls}" style="width:${v}%" title="${label} ${Math.round(v)}%">${v >= 12 ? `${label} ${Math.round(v)}%` : ''}</div>` : '';
    bar = `<div class="probbar" role="img" aria-label="買い ${Math.round(pr.buy)}%、様子見 ${Math.round(pr.hold)}%、売り ${Math.round(pr.sell)}%">
        ${seg('b', pr.buy, '買い')}${seg('h', pr.hold, '様子見')}${seg('s', pr.sell, '売り')}
      </div>
      <div class="legend"><span><i style="background:var(--buy)"></i>買い</span><span><i style="background:var(--hold)"></i>様子見</span><span><i style="background:var(--sell)"></i>売り</span></div>
      ${pr.binary ? '<p class="muted small" style="margin:4px 0 0">この予想は「TOPIXに勝つ/負ける」の2択なので、様子見の幅はありません。</p>' : ''}`;
  } else {
    bar = '<p class="muted small">確率の記録がありません</p>';
  }
  const news = Array.isArray(p.news_refs) ? p.news_refs : [];
  const newsHtml = news.length
    ? `<ul class="news">${news.map((n) => {
        if (typeof n === 'string') return `<li>${esc(n)}</li>`;
        const title = n.title || n.headline || '';
        const d = n.date || n.published || '';
        return `<li>${esc(title)}${d ? ` <span class="muted">（${esc(fmtDate(d))}）</span>` : ''}</li>`;
      }).join('')}</ul>`
    : '<p class="muted small" style="margin:6px 0 0">根拠のニュース: なし（ニュースを使わずに予想）</p>';
  const conf = num(p.confidence);
  return `<div class="pred">
    <div class="pred-head"><h3>${esc(p.name || '')} <span class="code">${esc(p.ticker || '')}</span></h3>${dirBadge(p)}</div>
    ${bar}
    <div class="kv">
      <span>確信度 <b>${conf != null ? conf + '%' : '—'}</b></span>
      <span>期間 <b>${esc(trackLabel(p.track))}</b></span>
      ${p.due_date ? `<span>答え合わせ <b>${esc(fmtDate(p.due_date))}</b></span>` : ''}
    </div>
    ${p.rationale ? `<p class="rationale">${esc(p.rationale)}</p>` : ''}
    ${newsHtml}
  </div>`;
}

function renderToday() {
  if (!state.predictions.length) {
    $('todayTitle').textContent = '今日のおすすめ';
    $('todayBox').innerHTML = emptyBox();
    return;
  }
  const dates = state.predictions.map((p) => String(p.predicted_at || '')).filter(Boolean).sort();
  const latest = dates[dates.length - 1];
  const list = state.predictions.filter((p) => String(p.predicted_at || '') === latest)
    .sort((a, b) => (num(b.confidence) || 0) - (num(a.confidence) || 0));
  const isToday = latest === todayStr();
  $('todayTitle').textContent = isToday ? '今日のおすすめ' : `最新のおすすめ（${fmtDate(latest)}の予想）`;
  $('todayBox').innerHTML = (isToday ? '' : '<p class="muted small" style="margin:0 0 8px">今日の予想はまだないので、いちばん新しい日の予想を出しています。</p>')
    + list.map(predCard).join('');
}

function renderCalib() {
  const pairs = scoredPairs().filter((x) => x.p && num(x.p.confidence) != null);
  const bands = [
    { lo: 50, hi: 59, label: '50-59%' },
    { lo: 60, hi: 69, label: '60-69%' },
    { lo: 70, hi: 79, label: '70-79%' },
    { lo: 80, hi: 100, label: '80%以上' },
  ].map((b) => {
    const ps = pairs.filter((x) => { const c = num(x.p.confidence); return c >= b.lo && c <= b.hi; });
    const n = ps.length;
    const hits = ps.filter((x) => x.r.hit).length;
    const meanConf = n ? ps.reduce((s, x) => s + num(x.p.confidence), 0) / n : null;
    return { ...b, n, hits, rate: n ? (hits / n) * 100 : null, meanConf };
  });

  // SVG: x = 確信度 50..100, y = 的中率 0..100
  const W = 320, H = 240, L = 40, R = 14, T = 24, B = 36;
  const x = (v) => L + ((v - 50) / 50) * (W - L - R);
  const y = (v) => T + (1 - v / 100) * (H - T - B);
  let g = '';
  for (const v of [0, 25, 50, 75, 100]) {
    g += `<line class="axis" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>`;
    g += `<text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}%</text>`;
  }
  for (const v of [50, 60, 70, 80, 90, 100]) {
    g += `<text x="${x(v)}" y="${H - B + 16}" text-anchor="middle">${v}%</text>`;
  }
  g += `<text x="${(L + W - R) / 2}" y="${H - 4}" text-anchor="middle">確信度</text>`;
  g += `<line class="ideal" x1="${x(50)}" y1="${y(50)}" x2="${x(100)}" y2="${y(100)}"/>`;
  g += `<text x="${x(97)}" y="${y(100) + 14}" text-anchor="end">理想</text>`;
  const pts = bands.filter((b) => b.n > 0);
  if (pts.length > 1) {
    g += `<polyline class="real" points="${pts.map((b) => `${x(b.meanConf)},${y(b.rate)}`).join(' ')}"/>`;
  }
  for (const b of pts) {
    g += `<circle class="dot" cx="${x(b.meanConf)}" cy="${y(b.rate)}" r="5"/>`;
    g += `<text class="lbl" x="${x(b.meanConf)}" y="${y(b.rate) - 9}" text-anchor="middle">${Math.round(b.rate)}%</text>`;
  }
  const svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="確信度ごとの的中率。点線は確信度どおりに当たる理想のライン">${g}</svg>`;
  const legend = `<div class="legend" style="justify-content:center;margin-top:4px">
      <span><i style="background:var(--accent)"></i>実際の的中率</span>
      <span>┄ 点線＝理想（確信度どおり当たる）</span></div>`;
  if (!pairs.length) {
    $('calibBox').innerHTML = svg + legend + `<div class="empty" style="margin-top:8px">${EMPTY_TEXT}</div>`;
    return;
  }
  const table = `<table class="calib-table"><thead><tr><th>確信度</th><th>件数</th><th>的中</th><th>的中率</th></tr></thead><tbody>
    ${bands.map((b) => `<tr><td>${b.label}</td><td>${b.n}</td><td>${b.n ? b.hits : '—'}</td><td>${b.rate != null ? Math.round(b.rate) + '%' : '—'}</td></tr>`).join('')}
    </tbody></table>`;
  const few = pairs.length < 20 ? '<p class="muted small" style="margin:6px 0 0">件数が少ないうちは、たまたまの影響が大きいので参考程度に。</p>' : '';
  $('calibBox').innerHTML = svg + legend + table + few;
}

/** notes.md から「展望」を含む見出しのセクションを取り出す（最後に出てきたもの） */
function extractOutlook(md) {
  const lines = String(md || '').split(/\r?\n/);
  let start = -1, level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.*)$/);
    if (m && /展望/.test(m[2])) { start = i; level = m[1].length; }
  }
  if (start < 0) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+/);
    if (m && m[1].length <= level) break;
    body.push(lines[i]);
  }
  const text = body.join('\n').trim();
  return { heading: lines[start].replace(/^#+\s+/, ''), text };
}
function renderOutlook() {
  const o = extractOutlook(state.notes);
  if (!o || !o.text) {
    $('outlookBox').innerHTML = emptyBox('notes.md に「## 今後の展望」の見出しで書くと、ここに出ます');
    return;
  }
  const md = o.text.replace(/^\s*[-*]\s+/gm, '・').replace(/\*\*(.+?)\*\*/g, '$1');
  $('outlookBox').innerHTML = `<p class="muted small" style="margin:0 0 6px">${esc(o.heading)}（notes.md より）</p><p class="outlook">${esc(md)}</p>`;
}

function renderWatch() {
  const res = resultsById();
  $('watchBox').innerHTML = WATCHLIST.map((w) => {
    const p = latestPredictionFor(w.ticker);
    const cp = currentPrice(w.ticker);
    const done = state.predictions.filter((x) => normTicker(x.ticker) === w.ticker && res.has(x.id));
    const doneHits = done.filter((x) => res.get(x.id).hit === true).length;
    const pr = p ? probsOf(p) : null;
    return `<div class="watch">
      <div class="pred-head"><h3>${esc(w.name)} <span class="code">${esc(w.ticker)}</span></h3>${dirBadge(p)}</div>
      <div class="kv">
        <span>現在値 <b>${cp ? fmtYen(cp.price) : '—'}</b>${cp && cp.src === 'manual' ? ' <span class="muted small">(手入力)</span>' : ''}${cp && cp.date ? ` <span class="muted small">${esc(fmtDate(cp.date))}</span>` : ''}</span>
        ${p ? `<span>確信度 <b>${num(p.confidence) != null ? num(p.confidence) + '%' : '—'}</b></span>` : ''}
        ${p ? `<span>予想日 <b>${esc(fmtDate(p.predicted_at))}</b></span>` : ''}
        ${pr ? `<span>売る目安 <b>${Math.round(pr.sell)}%</b></span>` : ''}
      </div>
      ${p && p.rationale ? `<p class="rationale">${esc(p.rationale)}</p>` : ''}
      ${done.length ? `<p class="muted small" style="margin:4px 0 0">この銘柄の答え合わせ: ${doneHits}/${done.length} 的中</p>` : ''}
      ${cp ? '' : '<p class="muted small" style="margin:4px 0 0">現在値は prices.json にまだありません</p>'}
    </div>`;
  }).join('');
}

/* ---------- 描画: 売買 ---------- */
function computeHoldings() {
  // 移動平均法: 買うたびに平均取得単価を更新、売ると株数だけ減る
  const map = new Map();
  const sorted = [...state.trades].sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  for (const t of sorted) {
    const tk = normTicker(t.ticker);
    const sh = num(t.shares), pr = num(t.price);
    if (!tk || sh == null || sh <= 0) continue;
    const h = map.get(tk) || { ticker: tk, name: t.name || '', shares: 0, cost: 0 };
    if (t.name) h.name = t.name;
    if (t.side === 'buy' && pr != null) {
      h.cost += sh * pr;
      h.shares += sh;
    } else if (t.side === 'sell') {
      const avg = h.shares > 0 ? h.cost / h.shares : 0;
      const s = Math.min(sh, h.shares);
      h.shares -= s;
      h.cost -= avg * s;
    }
    map.set(tk, h);
  }
  return [...map.values()].filter((h) => h.shares > 0)
    .map((h) => ({ ...h, avg: h.cost / h.shares }));
}

function renderHoldings() {
  const hs = computeHoldings();
  if (!hs.length) { $('holdBox').innerHTML = emptyBox(); return; }
  $('holdBox').innerHTML = hs.map((h) => {
    const cp = currentPrice(h.ticker);
    const pl = cp ? ((cp.price - h.avg) / h.avg) * 100 : null;
    const p = latestPredictionFor(h.ticker);
    const pr = p ? probsOf(p) : null;
    const conf = p ? num(p.confidence) : null;
    const name = h.name || nameFor(h.ticker);
    return `<div class="hold">
      <div class="pred-head"><h3>${esc(name)} <span class="code">${esc(h.ticker)}</span></h3><span class="muted small">${h.shares.toLocaleString('ja-JP')}株</span></div>
      <div class="hold-grid">
        <div><div class="l">買値（平均）</div><div class="v">${fmtYen(Math.round(h.avg * 100) / 100)}</div></div>
        <div><div class="l">現在値${cp && cp.src === 'manual' ? '（手入力）' : ''}</div><div class="v">${cp ? fmtYen(cp.price) : '—'}</div></div>
        <div><div class="l">損益</div><div class="v ${pl == null ? '' : pl >= 0 ? 'pos' : 'neg'}">${fmtPct(pl)}</div></div>
        <div><div class="l">売る確率の目安</div><div class="v">${pr ? Math.round(pr.sell) + '%' : '予想なし'}</div></div>
        <div><div class="l">確信度</div><div class="v">${conf != null ? conf + '%' : '予想なし'}</div></div>
        <div><div class="l">予想日</div><div class="v">${p ? esc(fmtDate(p.predicted_at)) : '—'}</div></div>
      </div>
      ${cp && cp.src === 'file' ? '' : `<div class="manual">
        <input type="number" inputmode="decimal" min="0" step="any" placeholder="現在値を手入力（円）" aria-label="${esc(name)}の現在値" data-manual="${esc(h.ticker)}" value="${cp ? esc(cp.price) : ''}">
        <button class="btn small" type="button" data-manual-save="${esc(h.ticker)}">反映</button>
      </div>`}
    </div>`;
  }).join('') + '<p class="muted small" style="margin:10px 0 0">「売る確率の目安」はその銘柄の最新の予想から出しています（TOPIXに負ける見込み）。</p>';
}

function renderRecent() {
  const list = [...state.trades].sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))).slice(0, 8);
  if (!list.length) { $('recentBox').innerHTML = emptyBox(); return; }
  $('recentBox').innerHTML = `<ul class="recent">${list.map((t) => {
    const d = t.at ? new Date(t.at) : null;
    const when = d && !isNaN(d) ? `${d.getMonth() + 1}/${d.getDate()}` : '';
    const side = t.side === 'buy' ? '<b class="pos">買</b>' : t.side === 'sell' ? '<b class="neg">売</b>' : '?';
    return `<li>${side} ${esc(t.name || nameFor(t.ticker))} <span class="muted">${esc(normTicker(t.ticker))}</span> ${esc(num(t.shares) ?? '')}株 × ${fmtYen(num(t.price))} <span class="muted small">${esc(when)}</span>${t.memo ? `<br><span class="muted small">${esc(t.memo)}</span>` : ''}</li>`;
  }).join('')}</ul>`;
}

function renderTickerList() {
  const seen = new Map();
  for (const w of WATCHLIST) seen.set(w.ticker, w.name);
  for (const p of state.predictions) { const t = normTicker(p.ticker); if (t && !seen.has(t)) seen.set(t, p.name || ''); }
  for (const t of state.trades) { const k = normTicker(t.ticker); if (k && !seen.has(k)) seen.set(k, t.name || ''); }
  $('tickerList').innerHTML = [...seen].map(([t, n]) => `<option value="${esc(t)}">${esc(n)}</option>`).join('');
}

function renderAll() {
  renderStats();
  renderToday();
  renderCalib();
  renderOutlook();
  renderWatch();
  renderHoldings();
  renderRecent();
  renderTickerList();
}

/* ---------- 読み込み ---------- */
let loading = false;
async function loadAll() {
  if (loading) return;
  loading = true;
  const msg = $('loadMsg');
  msg.className = 'load-msg';
  msg.textContent = '読み込み中…';
  $('reloadBtn').disabled = true;
  try {
    const [pred, res, notes, prices, trades] = await Promise.all([
      readFile('predictions.jsonl'),
      readFile('results.jsonl'),
      readFile('notes.md'),
      readFile('prices.json'),
      readFile('trades.jsonl'),
    ]);
    const warns = [];
    const pp = parseJsonl(pred && pred.text);
    const rr = parseJsonl(res && res.text);
    const tt = parseJsonl(trades && trades.text);
    if (pp.bad) warns.push(`predictions.jsonl の${pp.bad}行が読めませんでした`);
    if (rr.bad) warns.push(`results.jsonl の${rr.bad}行が読めませんでした`);
    if (tt.bad) warns.push(`trades.jsonl の${tt.bad}行が読めませんでした`);
    state.predictions = pp.rows;
    state.results = rr.rows;
    state.trades = tt.rows;
    state.notes = notes ? notes.text : '';
    state.prices = {};
    if (prices) {
      try {
        const n = normalizePrices(JSON.parse(prices.text));
        state.prices = n.out;
        state.pricesDate = n.date;
      } catch { warns.push('prices.json が読めませんでした'); }
    }
    state.loaded = true;
    renderAll();
    const d = new Date();
    msg.textContent = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')} に読み込みました` + (warns.length ? ` ／ ${warns.join('、')}` : '');
    if (warns.length) msg.className = 'load-msg err';
  } catch (e) {
    msg.className = 'load-msg err';
    msg.textContent = explainError(e);
    if (!state.loaded) renderAll();
  } finally {
    loading = false;
    $('reloadBtn').disabled = false;
  }
}

/* ---------- 書き込み（trades.jsonl へ追記） ---------- */
async function appendTrade(entry) {
  const line = JSON.stringify(entry);
  for (let attempt = 1; attempt <= 4; attempt++) {
    const cur = await readFile('trades.jsonl');
    let text = cur ? cur.text : '';
    if (text && !text.endsWith('\n')) text += '\n';
    text += line + '\n';
    const body = {
      message: `trade: ${entry.side} ${entry.ticker} x${entry.shares}`,
      content: utf8ToB64(text),
    };
    if (cur) body.sha = cur.sha;
    try {
      await gh('/contents/trades.jsonl', { method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
      return parseJsonl(text).rows;
    } catch (e) {
      // 409: sha が古い（誰かが先に書いた）/ 422: 新規作成のつもりが既にあった など → 読み直してやり直す
      if ((e.status === 409 || e.status === 422) && attempt < 4) {
        await new Promise((r) => setTimeout(r, 400 * attempt));
        continue;
      }
      throw e;
    }
  }
  throw new Error('retry');
}

function heldShares(ticker) {
  const h = computeHoldings().find((x) => x.ticker === normTicker(ticker));
  return h ? h.shares : 0;
}

async function onTradeSubmit(ev) {
  ev.preventDefault();
  const msg = $('tradeMsg');
  msg.className = 'msg';
  const side = document.querySelector('input[name=side]:checked').value;
  const ticker = normTicker($('tCode').value);
  const name = $('tName').value.trim() || nameFor(ticker);
  const shares = num($('tShares').value);
  const price = num($('tPrice').value);
  const memo = $('tMemo').value.trim();
  if (!/^[0-9A-Z]{3,6}$/.test(ticker)) { msg.className = 'msg err'; msg.textContent = '銘柄コードを確認してね（例 7203）'; return; }
  if (!shares || shares <= 0 || !Number.isInteger(shares)) { msg.className = 'msg err'; msg.textContent = '株数は1以上の整数で入れてね'; return; }
  if (price == null || price <= 0) { msg.className = 'msg err'; msg.textContent = '1株の値段を入れてね'; return; }
  if (side === 'sell' && state.loaded && shares > heldShares(ticker)) {
    msg.className = 'msg err';
    msg.textContent = `記録上の持ち株は ${heldShares(ticker)}株 なので、それより多くは売れないよ`;
    return;
  }
  const entry = {
    id: `${todayStr()}-${ticker}-${Date.now().toString(36)}`,
    at: new Date().toISOString(),
    side, ticker, name, shares, price, memo,
  };
  const btn = $('tradeBtn');
  btn.disabled = true;
  btn.textContent = '記録中…';
  try {
    state.trades = await appendTrade(entry);
    renderHoldings();
    renderRecent();
    renderTickerList();
    msg.className = 'msg ok';
    msg.textContent = `記録しました: ${side === 'buy' ? '買い' : '売り'} ${name || ticker} ${shares}株 × ${fmtYen(price)}`;
    $('tShares').value = '';
    $('tPrice').value = '';
    $('tMemo').value = '';
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = '記録できませんでした: ' + explainError(e);
  } finally {
    btn.disabled = false;
    btn.textContent = '記録する';
  }
}

/* ---------- 画面切り替え ---------- */
function showView(id) {
  for (const v of ['setupView', 'dashView', 'tradeView']) $(v).hidden = v !== id;
  const authed = id !== 'setupView';
  $('tabs').hidden = !authed;
  $('topActions').hidden = !authed;
  for (const t of document.querySelectorAll('.tab')) {
    if (t.dataset.view === id) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  }
  if (authed) lsSet(TAB_KEY, id);
  window.scrollTo(0, 0);
}

function openSetup(fromSettings) {
  $('forgetBox').hidden = !fromSettings;
  $('tokenInput').value = '';
  $('setupMsg').textContent = '';
  showView('setupView');
  $('topActions').hidden = true;
  $('tabs').hidden = true;
}

async function onSetupSubmit(ev) {
  ev.preventDefault();
  const tok = $('tokenInput').value.trim();
  const msg = $('setupMsg');
  msg.className = 'msg';
  if (!tok) return;
  if (/\s/.test(tok)) { msg.className = 'msg err'; msg.textContent = '鍵に空白が入っています。コピーし直してね。'; return; }
  const btn = $('setupBtn');
  btn.disabled = true;
  msg.textContent = '鍵を確かめています…';
  const prev = lsGet(TOKEN_KEY);
  if (!lsSet(TOKEN_KEY, tok)) {
    btn.disabled = false;
    msg.className = 'msg err';
    msg.textContent = 'このブラウザでは保存できませんでした（プライベートモードなど）。';
    return;
  }
  try {
    await gh('');
    $('tokenInput').value = '';
    btn.disabled = false;
    const tab = lsGet(TAB_KEY);
    showView(tab === 'tradeView' ? 'tradeView' : 'dashView');
    loadAll();
  } catch (e) {
    if (prev) lsSet(TOKEN_KEY, prev); else lsDel(TOKEN_KEY);
    btn.disabled = false;
    msg.className = 'msg err';
    msg.textContent = explainError(e);
  }
}

/* ---------- 起動 ---------- */
function init() {
  $('setupForm').addEventListener('submit', onSetupSubmit);
  $('tradeForm').addEventListener('submit', onTradeSubmit);
  $('reloadBtn').addEventListener('click', loadAll);
  $('keyBtn').addEventListener('click', () => openSetup(true));
  $('cancelSetupBtn').addEventListener('click', () => {
    if (getToken()) showView(lsGet(TAB_KEY) === 'tradeView' ? 'tradeView' : 'dashView');
  });
  $('forgetBtn').addEventListener('click', () => {
    lsDel(TOKEN_KEY);
    state.loaded = false;
    openSetup(false);
    $('setupMsg').className = 'msg ok';
    $('setupMsg').textContent = '鍵を消しました。';
  });
  for (const t of document.querySelectorAll('.tab')) {
    t.addEventListener('click', () => showView(t.dataset.view));
  }
  $('tCode').addEventListener('change', () => {
    const t = normTicker($('tCode').value);
    const n = t ? nameFor(t) : '';
    if (n) $('tName').value = n;
  });
  $('holdBox').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-manual-save]');
    if (!b) return;
    const t = b.dataset.manualSave;
    const input = $('holdBox').querySelector(`[data-manual="${CSS.escape(t)}"]`);
    const v = num(input && input.value);
    setManualPrice(t, v != null && v > 0 ? v : null);
    renderHoldings();
    renderWatch();
  });

  if (!getToken()) { openSetup(false); return; }
  showView(lsGet(TAB_KEY) === 'tradeView' ? 'tradeView' : 'dashView');
  loadAll();
}

init();
