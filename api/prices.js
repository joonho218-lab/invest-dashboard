// GET /api/prices?symbol=QQQ  → { symbol, name, currency, source, dates: [...], close: [...] }
// Fetches full daily history server-side (no CORS issues in the browser).
// US tickers as-is (QQQ, AAPL, ^GSPC). Korean 6-digit codes try KOSPI(.KS) then KOSDAQ(.KQ).

const UA = "Mozilla/5.0 (compatible; invest-dashboard/1.0)";

export function normalizeSymbols(raw) {
  const s = String(raw || "").trim().toUpperCase();
  if (!s || s.length > 20 || !/^[\^A-Z0-9.\-=]+$/.test(s)) return [];
  if (/^\d{6}$/.test(s)) return [`${s}.KS`, `${s}.KQ`];
  return [s];
}

export function parseYahoo(json) {
  const r = json && json.chart && json.chart.result && json.chart.result[0];
  if (!r || !r.timestamp) return null;
  const meta = r.meta || {};
  const off = (meta.gmtoffset || 0) * 1000;
  const close = (r.indicators.quote && r.indicators.quote[0] && r.indicators.quote[0].close) || [];
  const adj = (r.indicators.adjclose && r.indicators.adjclose[0] && r.indicators.adjclose[0].adjclose) || close;
  const map = new Map();
  r.timestamp.forEach((t, i) => {
    const v = adj[i] != null ? adj[i] : close[i];
    if (v == null || !(v > 0)) return;
    const d = new Date(t * 1000 + off).toISOString().slice(0, 10);
    map.set(d, Math.round(v * 10000) / 10000);
  });
  const rows = [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return {
    symbol: meta.symbol,
    name: meta.longName || meta.shortName || meta.symbol,
    currency: meta.currency || "",
    dates: rows.map((x) => x[0]),
    close: rows.map((x) => x[1]),
  };
}

async function fromYahoo(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=max&interval=1d&events=div%2Csplit&includeAdjustedClose=true`;
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`yahoo ${res.status}`);
  const out = parseYahoo(await res.json());
  if (!out || out.dates.length === 0) throw new Error("yahoo empty");
  return { ...out, source: "Yahoo Finance (수정종가)" };
}

async function fromStooq(sym) {
  if (!/^[A-Z0-9.\-]+$/.test(sym) || sym.includes(".")) throw new Error("stooq skip");
  const res = await fetch(`https://stooq.com/q/d/l/?s=${sym.toLowerCase()}.us&i=d`, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`stooq ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split(/\r?\n/);
  if (!/^date/i.test(lines[0] || "")) throw new Error("stooq format");
  const dates = [], close = [];
  for (const l of lines.slice(1)) { const c = l.split(","); const v = Number(c[4]); if (c[0] && v > 0) { dates.push(c[0]); close.push(v); } }
  if (!dates.length) throw new Error("stooq empty");
  return { symbol: sym, name: sym, currency: "USD", dates, close, source: "Stooq (종가)" };
}

export default async function handler(req, res) {
  const q = (req.query && req.query.symbol) || new URL(req.url, "http://x").searchParams.get("symbol");
  const candidates = normalizeSymbols(q);
  if (!candidates.length) { res.status(400).json({ error: "티커를 확인해 주세요. 예: QQQ, AAPL, 005930" }); return; }
  const errors = [];
  for (const sym of candidates) {
    for (const src of [fromYahoo, fromStooq]) {
      try {
        const data = await src(sym);
        res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
        res.status(200).json(data);
        return;
      } catch (e) { errors.push(`${sym}: ${e.message}`); }
    }
  }
  res.status(404).json({ error: `가격을 찾지 못했습니다 (${candidates.join(", ")}).`, detail: errors });
}
