// 분할매수 플래너 — 연결된 텔레그램으로 메시지 보내기 (pg_cron · SQL에서 호출, cron 비밀값 필요)
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  const { data: sec } = await db.from("app_secrets").select("value").eq("name", "cron_secret").single();
  if (!sec || req.headers.get("x-cron-secret") !== sec.value) return json({ error: "forbidden" }, 403);
  const body: any = await req.json().catch(() => ({}));
  const text = String(body?.text || "").slice(0, 4000);
  if (!text || !TOKEN) return json({ error: "no_text_or_token" }, 400);
  const { data: accs } = await db.from("planner_accounts").select("tg_chat_id").not("tg_chat_id", "is", null);
  let sent = 0; const errors: string[] = [];
  for (const a of accs || []) {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: a.tg_chat_id, text, disable_web_page_preview: true, ...(body?.html ? { parse_mode: "HTML" } : {}) }) });
    const j = await r.json().catch(() => ({}));
    if (j.ok) sent++; else errors.push(j.description || String(r.status));
  }
  return json({ ok: true, sent, errors });
});
