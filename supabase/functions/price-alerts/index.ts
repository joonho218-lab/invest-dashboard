// 분할매수 플래너 — 장 마감 뒤 가격 확인 후 텔레그램 알림 (pg_cron이 호출)
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const UA = "Mozilla/5.0 (compatible; bunhal-planner/1.0)";
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

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
async function lastClose(sym: string) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d`, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!r.ok) throw new Error(`yahoo ${r.status}`);
  const j = await r.json(); const res = j?.chart?.result?.[0];
  const ts: number[] = res?.timestamp || []; const cl: (number | null)[] = res?.indicators?.quote?.[0]?.close || [];
  const off = (res?.meta?.gmtoffset || 0) * 1000;
  for (let i = ts.length - 1; i >= 0; i--) if (cl[i] != null && (cl[i] as number) > 0) return { price: cl[i] as number, date: new Date(ts[i] * 1000 + off).toISOString().slice(0, 10) };
  throw new Error("no_price");
}
const fmtP = (v: number) => v >= 1000 ? Math.round(v).toLocaleString("ko-KR") : v.toFixed(2);
const fmtQ = (q: number) => (Math.round(q * 10000) / 10000).toLocaleString("ko-KR", { maximumFractionDigits: 4 });

Deno.serve(async (req) => {
  const { data: sec } = await db.from("app_secrets").select("value").eq("name", "cron_secret").single();
  if (!sec || req.headers.get("x-cron-secret") !== sec.value) return json({ error: "forbidden" }, 403);
  let body: any = {}; try { body = await req.json(); } catch { /* empty body */ }
  if (typeof body?.probe === "string") { // 점검용: 가격 조회만 시험
    try { return json({ probe: body.probe, ...(await lastClose(body.probe)) }); } catch (e) { return json({ probe: body.probe, error: (e as Error).message }, 502); }
  }
  const dry = !!body?.dry;
  const out: any = { dry, prices: {}, sent: [], errors: [] };
  try { if (TOKEN) await processUpdates(); } catch (e) { out.errors.push(`updates: ${(e as Error).message}`); }

  const { data: accounts } = await db.from("planner_accounts").select("id,tg_chat_id,site_url").not("tg_chat_id", "is", null);
  for (const acc of accounts || []) {
    const { data: tickers } = await db.from("planner_tickers").select("symbol,name,levels").eq("account_id", acc.id).eq("watch", true);
    const blocks: string[] = []; const logRows: any[] = [];
    for (const t of tickers || []) {
      const items: any[] = Array.isArray(t.levels?.items) ? t.levels.items : [];
      if (!items.length) continue;
      let px: { price: number; date: string };
      if (out.prices[t.symbol]) px = out.prices[t.symbol];
      else { try { px = await lastClose(t.symbol); out.prices[t.symbol] = px; } catch (e) { out.errors.push(`${t.symbol}: ${(e as Error).message}`); continue; } }
      const hits = items.filter((x) => typeof x.price === "number" && (x.kind === "buy" ? px.price <= x.price : x.kind === "trail" ? px.price < x.price : px.price >= x.price));
      const lines: string[] = [];
      for (const h of hits) {
        // 같은 단계·같은 가격은 7일에 한 번만
        const { data: prev } = await db.from("planner_alert_log").select("level_price,sent_at").eq("account_id", acc.id).eq("symbol", t.symbol).eq("level_key", h.key).order("sent_at", { ascending: false }).limit(1);
        const p0 = prev?.[0];
        if (p0 && Math.abs(Number(p0.level_price) / h.price - 1) < 0.005 && Date.now() - Date.parse(p0.sent_at) < 7 * 864e5) continue;
        const icon = h.kind === "buy" ? "🔴 매수 차례" : h.kind === "trail" ? "🟢 추세 정리" : "🟢 매도 차례";
        lines.push(` ${icon}: ${h.label} ${fmtP(h.price)}${h.q ? ` → ${fmtQ(h.q)}주` : ""}`);
        logRows.push({ account_id: acc.id, symbol: t.symbol, level_key: h.key, level_price: h.price, close_price: px.price });
      }
      if (lines.length) {
        const nm = String(t.name || t.symbol).replace(/\s*\([^)]*\)$/, "");
        const dd = t.levels?.high ? ` (52주 고점 대비 ${((px.price / t.levels.high - 1) * 100).toFixed(1)}%)` : "";
        const link = acc.site_url ? `\n ${acc.site_url.replace(/\/$/, "")}/?t=${encodeURIComponent(t.symbol.replace(/\.(KS|KQ)$/, ""))}#log` : "";
        blocks.push(`${nm} ${t.symbol !== nm ? `(${t.symbol}) ` : ""}${fmtP(px.price)}${dd} · ${px.date} 종가\n${lines.join("\n")}${link}`);
      }
    }
    if (!blocks.length) continue;
    const text = `📌 분할매수 알림\n\n${blocks.join("\n\n")}\n\n실제로 사고팔았으면 사이트 '진행 상황'에 기록해 주세요. 기록하면 다음 단계 수량이 다시 계산됩니다.`;
    out.sent.push({ account: acc.id, text });
    if (!dry) {
      try { await tg("sendMessage", { chat_id: acc.tg_chat_id, text, disable_web_page_preview: true }); await db.from("planner_alert_log").insert(logRows); }
      catch (e) { out.errors.push(`send: ${(e as Error).message}`); }
    }
  }
  return json(out);
});
