// GET /api/search?q=삼성전자 | 엔비디아 | nvidia | 005930  → { items: [{ symbol, name, market, type, exchange }] }
// 한글 이름은 네이버 증권 자동완성, 영문·티커는 Yahoo Finance 검색을 함께 써서 Yahoo 시세 티커로 맞춘다.
const UA = "Mozilla/5.0 (compatible; invest-dashboard/1.0)";
const HANGUL = /[가-힣]/;

export function fromNaver(items) {
  const out = [];
  for (const it of items || []) {
    const t = it.typeCode, code = String(it.code || "");
    if (it.nationCode === "KOR") {
      if (it.category === "index") {
        if (code === "KOSPI") out.push({ symbol: "^KS11", name: it.name, market: "KR", type: "지수", exchange: "KRX" });
        else if (code === "KOSDAQ") out.push({ symbol: "^KQ11", name: it.name, market: "KR", type: "지수", exchange: "KRX" });
        continue;
      }
      const suf = t === "KOSPI" ? ".KS" : t === "KOSDAQ" ? ".KQ" : null;
      if (!suf || !/^[0-9A-Z]{6}$/.test(code)) continue;
      const etf = /^(KODEX|TIGER|ACE|SOL|RISE|PLUS|KIWOOM|HANARO|KOSEF|ARIRANG|TIMEFOLIO|1Q|WON|BNK|UNICORN|마이티|에셋플러스|파워|히어로즈|TRUSTON|VITA|DAISHIN343|KCGI|FOCUS|ITF)\b/.test(it.name) || it.category === "etf";
      out.push({ symbol: code + suf, name: it.name, market: "KR", type: etf ? "ETF" : "주식", exchange: it.typeName || t });
    } else if (it.nationCode === "USA" && /^(NASDAQ|NYSE|AMEX)$/.test(t)) {
      out.push({ symbol: code.replace(/\./g, "-"), name: it.name, market: "US", type: it.category === "etf" || String(it.url || "").includes("/etf/") ? "ETF" : "주식", exchange: t });
    }
  }
  return out;
}
export function fromYahoo(quotes) {
  const ok = { EQUITY: "주식", ETF: "ETF", INDEX: "지수", MUTUALFUND: "펀드" };
  const out = [];
  for (const q of quotes || []) {
    if (!ok[q.quoteType] || !q.symbol) continue;
    const s = q.symbol; const kr = /\.(KS|KQ)$/.test(s);
    const us = !s.includes(".") || /^[A-Z]+-[A-Z]$/.test(s); // 미국 상장(접미사 없음) 위주
    if (!kr && !us && q.quoteType !== "INDEX") continue;
    out.push({ symbol: s, name: q.longname || q.shortname || s, market: kr ? "KR" : "US", type: ok[q.quoteType], exchange: q.exchDisp || q.exchange || "" });
  }
  return out;
}
async function naver(q) {
  const tries = [q]; if (/\s/.test(q)) tries.push(q.replace(/\s+/g, ""));
  for (const t of tries) {
    const r = await fetch(`https://ac.stock.naver.com/ac?q=${encodeURIComponent(t)}&target=stock,etf,index`, { headers: { "User-Agent": UA } });
    if (!r.ok) continue;
    const j = await r.json(); const out = fromNaver(j.items);
    if (out.length) return out;
  }
  return [];
}
async function yahoo(q) {
  const r = await fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0&listsCount=0`, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!r.ok) return [];
  const j = await r.json(); return fromYahoo(j.quotes);
}

export default async function handler(req, res) {
  const q = String((req.query && req.query.q) || new URL(req.url, "http://x").searchParams.get("q") || "").trim().slice(0, 40);
  if (!q) { res.status(400).json({ error: "검색어를 입력하세요." }); return; }
  const [a, b] = await Promise.all([naver(q).catch(() => []), HANGUL.test(q) ? Promise.resolve([]) : yahoo(q).catch(() => [])]);
  const first = HANGUL.test(q) ? a : [...b, ...a];
  const seen = new Set(); const items = [];
  for (const it of first) { if (seen.has(it.symbol)) continue; seen.add(it.symbol); items.push(it); if (items.length >= 10) break; }
  res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=604800");
  res.status(200).json({ items });
}
