// 분할매수 플래너 — 텔레그램 알림 (pg_cron이 호출)
//  mode "live"  : 장중 5분마다 실시간 가격으로 계획 단계 도달 알림
//  mode "close" : 장 마감 뒤 종가 알림 + 즐겨찾기 종목 낙폭 리포트
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const UA = "Mozilla/5.0 (compatible; bunhal-planner/1.0)";
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
const YH = "https://query1.finance.yahoo.com/v8/finance/chart/";

// 채널에서 자주 다룬 종목 (사이트 즐겨찾기와 같은 목록)
const REPORT_DEFAULT: Record<string, [string, string][]> = {
  US: [["^GSPC", "S&P500"], ["^IXIC", "나스닥 종합"], ["^SOX", "필라델피아 반도체"], ["SPY", "SPY"], ["QQQ", "QQQ"], ["SOXX", "SOXX"], ["SCHD", "SCHD"], ["IEF", "IEF 중기채"], ["GLD", "GLD 금"], ["ARKK", "ARKK"],
    ["NVDA", "엔비디아"], ["MU", "마이크론"], ["AMD", "AMD"], ["TSM", "TSMC"], ["ASML", "ASML"], ["MSFT", "마이크로소프트"], ["AMZN", "아마존"], ["META", "메타"], ["TSLA", "테슬라"], ["PLTR", "팔란티어"], ["HOOD", "로빈후드"], ["CRWV", "코어위브"], ["O", "리얼티인컴"], ["LEN", "레나"], ["BRK-B", "버크셔"],
    ["QLD", "QLD 나스닥2배"], ["TQQQ", "TQQQ 나스닥3배"], ["SOXL", "SOXL 반도체3배"]],
  KR: [["^KS11", "코스피"], ["^KQ11", "코스닥"], ["360750.KS", "TIGER 미국S&P500"], ["133690.KS", "TIGER 미국나스닥100"], ["305080.KS", "TIGER 미국채10년선물"], ["411060.KS", "ACE KRX금현물"], ["005930.KS", "삼성전자"], ["000660.KS", "SK하이닉스"]],
};
const marketOf = (s: string) => /\.(KS|KQ)$|^\^K(S|Q)11$/.test(s) ? "KR" : "US";

async function tg(method: string, body: Record<string, unknown> = {}) {
  if (!TOKEN) throw new Error("no_token");
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.description || "telegram_error");
  return j.result;
}
async function processUpdates() {
  const { data: off } = await db.from("app_secrets").select("value").eq("name", "tg_offset").single();
  const offset = Number(off?.value || 0);
  const updates = await tg("getUpdates", { offset, timeout: 0, allowed_updates: ["message"] }) as Array<any>;
  let next = offset;
  for (const u of updates) {
    next = Math.max(next, u.update_id + 1);
    const text: string = u.message?.text || "", chat = u.message?.chat?.id;
    const m = text.match(/^\/start\s+([A-Za-z0-9]{8,64})/);
    if (m && chat) {
      const { data: acc } = await db.from("planner_accounts").select("id").eq("tg_link_code", m[1]).maybeSingle();
      if (acc) {
        await db.from("planner_accounts").update({ tg_chat_id: chat }).eq("id", acc.id);
        await tg("sendMessage", { chat_id: chat, text: "✅ 분할매수 플래너와 연결됐습니다." });
      }
    }
  }
  if (next !== offset) await db.from("app_secrets").update({ value: String(next) }).eq("name", "tg_offset");
}
async function yahoo(sym: string, q: string) {
  const r = await fetch(`${YH}${encodeURIComponent(sym)}?${q}`, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!r.ok) throw new Error(`yahoo ${r.status}`);
  const res = (await r.json())?.chart?.result?.[0];
  if (!res) throw new Error("no_data");
  return res;
}
const day = (ts: number, off: number) => new Date(ts * 1000 + off * 1000).toISOString().slice(0, 10);
// 장 마감 종가
async function lastClose(sym: string) {
  const res = await yahoo(sym, "range=5d&interval=1d");
  const ts: number[] = res.timestamp || []; const cl: (number | null)[] = res.indicators?.quote?.[0]?.close || [];
  for (let i = ts.length - 1; i >= 0; i--) if (cl[i] != null && (cl[i] as number) > 0) return { price: cl[i] as number, date: day(ts[i], res.meta?.gmtoffset || 0) };
  throw new Error("no_price");
}
// 장중 실시간(정규장일 때만)
async function livePrice(sym: string) {
  const res = await yahoo(sym, "range=1d&interval=5m");
  const m = res.meta || {}; const now = Date.now() / 1000; const reg = m.currentTradingPeriod?.regular;
  const open = reg && now >= reg.start && now <= reg.end;
  return { open, price: m.regularMarketPrice as number, date: day(m.regularMarketTime || now, m.gmtoffset || 0), time: m.regularMarketTime as number, off: m.gmtoffset || 0 };
}
// 사이트와 같은 방식: 52주 최고가 대비 하락 사이클 → 단계 깊이
function stageDepths(c: number[]) {
  const n = c.length, W = 252; const hi = new Array(n); const dq: number[] = [];
  for (let i = 0; i < n; i++) { while (dq.length && c[dq[dq.length - 1]] <= c[i]) dq.pop(); dq.push(i); if (dq[0] <= i - W) dq.shift(); hi[i] = dq[0]; }
  const detect = (nh: boolean) => { const out: number[] = []; let cur: any = null;
    for (let i = 0; i < n; i++) {
      if (!cur) { const h = c[hi[i]]; if (c[i] <= h * 0.95) cur = { peak: h, low: c[i] }; }
      else { if (c[i] < cur.low) cur.low = c[i]; if (c[i] >= cur.peak || (nh && hi[i] === i)) { out.push(1 - cur.low / cur.peak); cur = null; } }
    } return out; };
  let m = detect(false); if (m.length < 10) { const a = detect(true); if (a.length > m.length) m = a; }
  m.sort((a, b) => b - a); const N = m.length; if (N < 10) return null;
  const depths = [0.5, 0.25, 0.125, 0.0625].map((p) => m[Math.max(0, Math.floor(p * N) - 1)]); depths.push(m[0]);
  return { depths, counts: depths.map((L) => m.filter((x) => x >= L - 1e-12).length), n: N };
}
const closes = (res: any) => { const a = res.indicators?.adjclose?.[0]?.adjclose || res.indicators?.quote?.[0]?.close || []; const ts: number[] = res.timestamp || []; const out: { d: string; v: number }[] = []; ts.forEach((t, i) => { const v = a[i]; if (v != null && v > 0) out.push({ d: day(t, res.meta?.gmtoffset || 0), v }); }); return out; };
const fmtP = (v: number) => v >= 1000 ? Math.round(v).toLocaleString("ko-KR") : v.toFixed(2);
const fmtQ = (q: number) => (Math.round(q * 10000) / 10000).toLocaleString("ko-KR", { maximumFractionDigits: 4 });
const pct = (x: number) => `${x > 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;

async function refreshMarket(market: string, extra: string[], out: any) {
  const syms = [...new Set([...REPORT_DEFAULT[market].map((x) => x[0]), ...extra.filter((s) => marketOf(s) === market)])];
  const { data: cache } = await db.from("planner_market_cache").select("*").in("symbol", syms);
  const byS: Record<string, any> = {}; (cache || []).forEach((r) => byS[r.symbol] = r);
  let heavy = 0;
  for (const s of syms) {
    try {
      const row: any = byS[s] || { symbol: s, market };
      if ((!row.levels_at || Date.now() - Date.parse(row.levels_at) > 7 * 864e5) && heavy < 8) { // 단계 깊이는 주 1회 전체 기간으로 다시 계산
        heavy++;
        const full = closes(await yahoo(s, `period1=0&period2=${Math.floor(Date.now() / 1000)}&interval=1d`));
        const st = stageDepths(full.map((x) => x.v));
        row.depths = st?.depths ?? null; row.counts = st?.counts ?? null; row.n = st?.n ?? null; row.levels_at = new Date().toISOString();
      }
      const y = closes(await yahoo(s, "range=1y&interval=1d"));
      const last = y[y.length - 1]; const high = Math.max(...y.slice(-252).map((x) => x.v));
      Object.assign(row, { market, last_price: last.v, high52: high, dd: last.v / high - 1, asof: last.d, updated_at: new Date().toISOString() });
      byS[s] = row;
      await db.from("planner_market_cache").upsert(row);
    } catch (e) { out.errors.push(`${s}: ${(e as Error).message}`); }
  }
  return syms.map((s) => byS[s]).filter((r) => r && r.last_price);
}
function reportText(market: string, rows: any[], names: Record<string, string>, site: string | null) {
  const asof = rows.map((r) => r.asof).sort().pop();
  const zone = (r: any) => (r.depths || []).filter((d: number) => -r.dd >= d - 1e-9).length;
  const line = (r: any) => {
    const z = zone(r); const D: number[] = r.depths || [];
    const next = z < D.length ? r.high52 * (1 - D[z]) : null;
    const nm = names[r.symbol] || r.symbol;
    return `• ${nm} ${fmtP(Number(r.last_price))} ${pct(Number(r.dd))}${z ? ` · ${z}단계 구간` : ""}${next ? ` → ${z + 1}단계 ${fmtP(next)} (${pct(next / r.last_price - 1)})` : z ? " · 최대 낙폭 넘어섬" : ""}`;
  };
  const inZone = rows.filter((r) => zone(r) > 0).sort((a, b) => a.dd - b.dd);
  const near = rows.filter((r) => zone(r) === 0 && r.depths && (r.high52 * (1 - r.depths[0])) / r.last_price - 1 > -0.05).sort((a, b) => a.dd - b.dd);
  const noLv = rows.filter((r) => !r.depths);
  const rest = rows.length - inZone.length - near.length - noLv.length;
  const parts = [`📊 ${market === "US" ? "미국장" : "국장"} 마감 낙폭 · ${asof} 종가`, "52주 고점 대비 하락폭과 과거 기준 매수 단계"];
  if (inZone.length) parts.push(`\n🔥 1단계 이상 내려온 종목\n${inZone.map(line).join("\n")}`);
  if (near.length) parts.push(`\n👀 1단계까지 5% 이내\n${near.map(line).join("\n")}`);
  if (!inZone.length && !near.length) parts.push("\n지금은 1단계 가까이 내려온 종목이 없어요.");
  if (rest > 0) parts.push(`\n그 외 ${rest}개는 1단계까지 5% 넘게 남았어요.`);
  if (noLv.length) parts.push(`\n📉 상장 기간이 짧아 단계 없이 낙폭만: ${noLv.map((r) => `${names[r.symbol] || r.symbol} ${pct(Number(r.dd))}`).join(", ")}`);
  if (site) parts.push(`\n계획 세우기: ${site.replace(/\/$/, "")}`);
  return parts.join("\n");
}

Deno.serve(async (req) => {
  const { data: sec } = await db.from("app_secrets").select("value").eq("name", "cron_secret").single();
  if (!sec || req.headers.get("x-cron-secret") !== sec.value) return json({ error: "forbidden" }, 403);
  let body: any = {}; try { body = await req.json(); } catch { /* empty */ }
  if (typeof body?.probe === "string") { try { return json({ probe: body.probe, ...(await lastClose(body.probe)) }); } catch (e) { return json({ probe: body.probe, error: (e as Error).message }, 502); } }
  const mode = body.mode === "live" ? "live" : body.mode === "warm" ? "warm" : "close";
  const market: string | null = body.market === "US" || body.market === "KR" ? body.market : null;
  const dry = !!body.dry;
  const out: any = { mode, market, dry, prices: {}, sent: [], errors: [] };
  if (mode === "warm") { for (const m of market ? [market] : ["US", "KR"]) out[m] = (await refreshMarket(m, [], out)).length; return json(out); }
  try { if (TOKEN) await processUpdates(); } catch (e) { out.errors.push(`updates: ${(e as Error).message}`); }

  const { data: accounts } = await db.from("planner_accounts").select("id,tg_chat_id,site_url,report,report_extra").not("tg_chat_id", "is", null);
  for (const acc of accounts || []) {
    const { data: tickers } = await db.from("planner_tickers").select("symbol,name,levels").eq("account_id", acc.id).eq("watch", true);
    const blocks: string[] = []; const logRows: any[] = [];
    for (const t of tickers || []) {
      if (market && marketOf(t.symbol) !== market) continue;
      const items: any[] = Array.isArray(t.levels?.items) ? t.levels.items : [];
      if (!items.length) continue;
      let px: any = out.prices[t.symbol];
      if (!px) {
        try { px = mode === "live" ? await livePrice(t.symbol) : await lastClose(t.symbol); out.prices[t.symbol] = px; }
        catch (e) { out.errors.push(`${t.symbol}: ${(e as Error).message}`); continue; }
      }
      if (mode === "live" && !px.open) continue; // 정규장이 아닐 때는 건너뜀
      const hits = items.filter((x) => typeof x.price === "number" && !(x.after && px.date < x.after) && (x.kind === "buy" ? px.price <= x.price : x.kind === "trail" ? px.price < x.price : px.price >= x.price));
      const lines: string[] = [];
      for (const h of hits) {
        // 같은 단계·같은 가격은 7일에 한 번만 (장중·마감 알림 공통)
        const { data: prev } = await db.from("planner_alert_log").select("level_price,sent_at").eq("account_id", acc.id).eq("symbol", t.symbol).eq("level_key", h.key).order("sent_at", { ascending: false }).limit(1);
        const p0 = prev?.[0];
        if (p0 && Math.abs(Number(p0.level_price) / h.price - 1) < 0.005 && Date.now() - Date.parse(p0.sent_at) < 7 * 864e5) continue;
        const icon = h.kind === "buy" ? "🔴 매수 차례" : h.kind === "trail" ? "🟢 추세 정리" : "🟢 매도 차례";
        lines.push(` ${icon}: ${h.label} ${fmtP(h.price)}${h.q ? ` → ${fmtQ(h.q)}주` : ""}`);
        logRows.push({ account_id: acc.id, symbol: t.symbol, level_key: h.key, level_price: h.price, close_price: px.price });
      }
      if (lines.length) {
        const nm = String(t.name || t.symbol).replace(/\s*\([^)]*\)$/, "");
        const dd = t.levels?.high ? ` (52주 고점 대비 ${pct(px.price / t.levels.high - 1)})` : "";
        const when = mode === "live" ? `지금 ${new Date((px.time + px.off) * 1000).toISOString().slice(11, 16)} 현지` : `${px.date} 종가`;
        const link = acc.site_url ? `\n ${acc.site_url.replace(/\/$/, "")}/?t=${encodeURIComponent(t.symbol.replace(/\.(KS|KQ)$/, ""))}#log` : "";
        blocks.push(`${nm} ${t.symbol !== nm ? `(${t.symbol}) ` : ""}${fmtP(px.price)}${dd} · ${when}\n${lines.join("\n")}${link}`);
      }
    }
    if (blocks.length) {
      const head = mode === "live" ? "⚡ 장중 분할매수 알림 (실시간 · 수 분 늦을 수 있음)" : "📌 분할매수 알림 (장 마감)";
      const text = `${head}\n\n${blocks.join("\n\n")}\n\n실제로 사고팔았으면 사이트 '진행 상황'에 기록해 주세요. 기록하면 다음 단계 수량이 다시 계산됩니다.`;
      out.sent.push({ account: acc.id, kind: mode, text });
      if (!dry) {
        try { await tg("sendMessage", { chat_id: acc.tg_chat_id, text, disable_web_page_preview: true }); await db.from("planner_alert_log").insert(logRows); }
        catch (e) { out.errors.push(`send: ${(e as Error).message}`); }
      }
    }
  }

  // 장 마감 낙폭 리포트
  if (mode === "close") {
    for (const m of market ? [market] : ["US", "KR"]) {
      const extras = [...new Set((accounts || []).flatMap((a: any) => Array.isArray(a.report_extra) ? a.report_extra.map((x: any) => x.symbol) : []))].filter(Boolean) as string[];
      const rows = await refreshMarket(m, extras, out);
      for (const acc of (accounts || []).filter((a: any) => a.report)) {
        const names: Record<string, string> = {}; REPORT_DEFAULT[m].forEach(([s, n]) => names[s] = n);
        const mine = (Array.isArray(acc.report_extra) ? acc.report_extra : []).filter((x: any) => marketOf(x.symbol) === m);
        mine.forEach((x: any) => names[x.symbol] = x.name || x.symbol);
        const list = rows.filter((r) => names[r.symbol]);
        if (!list.length) continue;
        const text = reportText(m, list, names, acc.site_url);
        out.sent.push({ account: acc.id, kind: "report", text });
        if (!dry) { try { await tg("sendMessage", { chat_id: acc.tg_chat_id, text, disable_web_page_preview: true }); } catch (e) { out.errors.push(`report: ${(e as Error).message}`); } }
      }
    }
  }
  return json(out);
});
