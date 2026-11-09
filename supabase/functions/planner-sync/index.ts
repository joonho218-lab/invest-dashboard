// 분할매수 플래너 — 기기 간 동기화 + 텔레그램 연결
// 인증: 브라우저가 만든 '연결 코드'(무작위 128비트 이상)의 SHA-256 해시로 계정을 찾는다.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function sha256(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function randomCode(n = 16) {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const r = crypto.getRandomValues(new Uint8Array(n));
  return [...r].map((x) => a[x % a.length]).join("");
}
async function tg(method: string, body: Record<string, unknown> = {}) {
  if (!TOKEN) throw new Error("no_token");
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.description || "telegram_error");
  return j.result;
}
// 봇에게 온 '/start <연결코드>' 메시지를 읽어 계정과 텔레그램 채팅을 잇는다 (웹훅 없이 getUpdates 사용)
// 텔레그램 '체결' 버튼 → 매매 기록에 추가하고 보유 현황에 반영
async function handleCallback(cq: any) {
  const chat = cq.message?.chat?.id; const data: string = cq.data || "";
  const ans = (text: string) => tg("answerCallbackQuery", { callback_query_id: cq.id, text, show_alert: false }).catch(() => {});
  const [tag, sym, key, priceS, qtyS] = data.split("|");
  if (tag !== "f" || !sym || !key) return ans("");
  const { data: acc } = await db.from("planner_accounts").select("id").eq("tg_chat_id", chat).maybeSingle();
  if (!acc) return ans("연결된 계정을 찾지 못했어요.");
  const { data: row } = await db.from("planner_tickers").select("trades,levels,plan").eq("account_id", acc.id).eq("symbol", sym).maybeSingle();
  if (!row) return ans("이 종목 계획을 찾지 못했어요.");
  const trades: any[] = Array.isArray(row.trades) ? row.trades : [];
  const nS = Array.isArray(row.plan?.sellLv) ? row.plan.sellLv.length : 3;
  const stage = key === "trail" ? `s${nS + 1}` : key;
  const type = stage.startsWith("b") ? "buy" : "sell";
  if (trades.some((t) => t.stage === stage && !t.imported)) return ans("이미 기록된 단계예요.");
  const price = Number(priceS); let qty = Number(qtyS);
  if (!(price > 0) || !(qty > 0)) return ans("가격·수량을 읽지 못했어요. 사이트에서 기록해 주세요.");
  if (type === "sell") {
    const held = trades.reduce((a, t) => a + (t.type === "buy" ? Number(t.qty) : -Number(t.qty)), 0);
    qty = Math.min(qty, Math.round(held * 10000) / 10000);
    if (!(qty > 0)) return ans("팔 수 있는 보유 수량이 없어요.");
  }
  const date = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  trades.push({ id: Date.now(), type, stage, date, price, qty, via: "telegram" });
  const items = (Array.isArray(row.levels?.items) ? row.levels.items : []).filter((x: any) => x.key !== key);
  await db.from("planner_tickers").update({ trades, levels: { ...(row.levels || {}), items }, updated_at: new Date().toISOString() }).eq("account_id", acc.id).eq("symbol", sym);
  await ans(`✅ 기록했어요 · ${type === "buy" ? "매수" : "매도"} ${qty}주 @ ${price}`);
  const kb = cq.message?.reply_markup?.inline_keyboard || [];
  const nk = kb.map((r: any[]) => r.map((b) => b.callback_data === data ? { text: `✔️ 기록됨 · ${String(b.text).replace(/^✅\s*/, "")}`, callback_data: "x" } : b));
  await tg("editMessageReplyMarkup", { chat_id: chat, message_id: cq.message?.message_id, reply_markup: { inline_keyboard: nk } }).catch(() => {});
}
async function processUpdates() {
  const { data: off } = await db.from("app_secrets").select("value").eq("name", "tg_offset").single();
  const offset = Number(off?.value || 0);
  const updates = await tg("getUpdates", { offset, timeout: 0, allowed_updates: ["message", "callback_query"] }) as Array<any>;
  let next = offset;
  for (const u of updates) {
    next = Math.max(next, u.update_id + 1);
    if (u.callback_query) { try { await handleCallback(u.callback_query); } catch (_) { /* ignore */ } continue; }
    const text: string = u.message?.text || "", chat = u.message?.chat?.id;
    if (!chat) continue;
    const m = text.match(/^\/start\s+([A-Za-z0-9]{8,64})/);
    if (m) {
      const { data: acc } = await db.from("planner_accounts").select("id").eq("tg_link_code", m[1]).maybeSingle();
      if (acc) {
        await db.from("planner_accounts").update({ tg_chat_id: chat }).eq("id", acc.id);
        await tg("sendMessage", { chat_id: chat, text: "✅ 분할매수 플래너와 연결됐습니다.\n계획한 매수·매도 가격에 닿으면 장 마감 뒤에 여기로 알려드릴게요.\n· 미국 종목: 오전 7시대\n· 한국 종목: 오후 4시대" });
      } else {
        await tg("sendMessage", { chat_id: chat, text: "연결 코드를 찾지 못했습니다. 사이트에서 '텔레그램 열기'를 다시 눌러 주세요." });
      }
    } else if (text.startsWith("/start")) {
      await tg("sendMessage", { chat_id: chat, text: "사이트의 '텔레그램 열기' 버튼으로 들어와야 연결됩니다." });
    }
  }
  if (next !== offset) await db.from("app_secrets").update({ value: String(next) }).eq("name", "tg_offset");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  if (body?.action === "market") { // 즐겨찾기 종목 장 마감 낙폭 (공용 데이터, 코드 필요 없음)
    const { data } = await db.from("planner_market_cache").select("symbol,market,depths,counts,n,last_price,high52,dd,asof");
    return json({ ok: true, rows: data || [] });
  }
  const code = String(body?.code || "");
  if (code.length < 20 || code.length > 100) return json({ error: "bad_code" }, 400);
  const hash = await sha256(code);
  const action = String(body.action || "");
  const site = typeof body.site === "string" && /^https?:\/\//.test(body.site) ? body.site.slice(0, 200) : null;

  if (action === "register") {
    const { data: ex } = await db.from("planner_accounts").select("id").eq("code_hash", hash).maybeSingle();
    if (!ex) { const { error } = await db.from("planner_accounts").insert({ code_hash: hash, site_url: site }); if (error) return json({ error: error.message }, 500); }
    else if (site) await db.from("planner_accounts").update({ site_url: site }).eq("id", ex.id);
    return json({ ok: true });
  }
  const { data: acc } = await db.from("planner_accounts").select("*").eq("code_hash", hash).maybeSingle();
  if (!acc) return json({ error: "unknown_code" }, 404);
  if (site && site !== acc.site_url) await db.from("planner_accounts").update({ site_url: site }).eq("id", acc.id);

  try {
    switch (action) {
      case "pull": {
        const { data } = await db.from("planner_tickers").select("symbol,name,ccy,plan,trades,watch,updated_at").eq("account_id", acc.id);
        return json({ ok: true, tickers: data || [], linked: !!acc.tg_chat_id, report: acc.report !== false });
      }
      case "push": {
        const list = Array.isArray(body.tickers) ? body.tickers.slice(0, 100) : [];
        if (JSON.stringify(list).length > 500_000) return json({ error: "too_large" }, 413);
        const rows = list.filter((t: any) => typeof t?.symbol === "string" && t.symbol.length <= 40).map((t: any) => ({
          account_id: acc.id, symbol: t.symbol, name: String(t.name || t.symbol).slice(0, 120), ccy: t.ccy === "KRW" ? "KRW" : "USD",
          plan: t.plan ?? null, trades: Array.isArray(t.trades) ? t.trades.slice(0, 1000) : [], watch: t.watch !== false,
          updated_at: t.updated_at && !isNaN(Date.parse(t.updated_at)) ? t.updated_at : new Date().toISOString(),
          ...(t.levels ? { levels: t.levels } : {}),
        }));
        // 서버 쪽이 더 최신(예: 텔레그램 '체결' 버튼으로 기록됨)이면 덮어쓰지 않고 알려준다 → 사이트가 다시 받아감
        const { data: cur } = await db.from("planner_tickers").select("symbol,updated_at").eq("account_id", acc.id).in("symbol", rows.map((r: any) => r.symbol));
        const srv: Record<string, number> = {}; (cur || []).forEach((r: any) => srv[r.symbol] = Date.parse(r.updated_at));
        const stale = rows.filter((r: any) => srv[r.symbol] && srv[r.symbol] > Date.parse(r.updated_at) + 1000).map((r: any) => r.symbol);
        const fresh = rows.filter((r: any) => !stale.includes(r.symbol));
        if (fresh.length) { const { error } = await db.from("planner_tickers").upsert(fresh, { onConflict: "account_id,symbol" }); if (error) return json({ error: error.message }, 500); }
        return json({ ok: true, saved: fresh.length, stale });
      }
      case "levels": { // 가격별 할 일만 갱신 (계획·기록은 건드리지 않음)
        const list = Array.isArray(body.tickers) ? body.tickers.slice(0, 100) : [];
        let n = 0;
        for (const t of list) {
          if (typeof t?.symbol !== "string" || !t.levels) continue;
          const { data } = await db.from("planner_tickers").update({ levels: t.levels }).eq("account_id", acc.id).eq("symbol", t.symbol).select("symbol");
          n += data?.length || 0;
        }
        return json({ ok: true, saved: n });
      }
      case "tg_link": {
        let link = acc.tg_link_code;
        if (!link) { link = randomCode(16); await db.from("planner_accounts").update({ tg_link_code: link }).eq("id", acc.id); }
        const me = await tg("getMe") as any;
        return json({ ok: true, url: `https://t.me/${me.username}?start=${link}`, bot: me.username, linked: !!acc.tg_chat_id });
      }
      case "tg_status": {
        if (!acc.tg_chat_id) await processUpdates();
        const { data: a2 } = await db.from("planner_accounts").select("tg_chat_id").eq("id", acc.id).single();
        return json({ ok: true, linked: !!a2?.tg_chat_id, hasToken: !!TOKEN });
      }
      case "tg_test": {
        if (!acc.tg_chat_id) return json({ error: "not_linked" }, 400);
        const { count } = await db.from("planner_tickers").select("symbol", { count: "exact", head: true }).eq("account_id", acc.id).eq("watch", true);
        await tg("sendMessage", { chat_id: acc.tg_chat_id, text: `🔔 테스트 알림입니다.\n지금 알림을 받는 종목: ${count ?? 0}개\n장 마감 뒤 계획 가격에 닿은 종목이 있으면 이렇게 알려드려요.` });
        return json({ ok: true });
      }
      case "prefs": {
        const upd: Record<string, unknown> = {};
        if (typeof body.report === "boolean") upd.report = body.report;
        if (Array.isArray(body.extra)) upd.report_extra = body.extra.filter((x: any) => typeof x?.symbol === "string" && x.symbol.length <= 40).slice(0, 60).map((x: any) => ({ symbol: x.symbol, name: String(x.name || x.symbol).slice(0, 40) }));
        if (Object.keys(upd).length) await db.from("planner_accounts").update(upd).eq("id", acc.id);
        return json({ ok: true });
      }
      case "tg_unlink": {
        await db.from("planner_accounts").update({ tg_chat_id: null }).eq("id", acc.id);
        return json({ ok: true });
      }
      default: return json({ error: "unknown_action" }, 400);
    }
  } catch (e) {
    const msg = (e as Error).message;
    return json({ error: msg === "no_token" ? "no_token" : msg }, msg === "no_token" ? 503 : 502);
  }
});
