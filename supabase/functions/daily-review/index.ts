// Supabase Edge Function: daily-review
//
// Once a day (pg_cron, 11:00 UTC = 07:00 America/New_York) this summarises
// the previous day's logged time from the shared `meetings` table and asks
// Gemini for the single easiest improvement the user could make today. The
// result is stored in `daily_reviews` (one row per owner+date) and shown as
// a card on the timelog site.
//
// Can also be invoked manually (POST, no body needed) for backfill/testing;
// an optional `?date=YYYY-MM-DD` query param reviews a specific day instead
// of yesterday.
//
// Auth: deploy with --no-verify-jwt; it only reads/writes the owner's own
// rows via the service-role key, and is triggered by cron.
//
// Required secrets:
//   GEMINI_API_KEY, OWNER_USER_ID, OWNER_TZ, SUPABASE_URL,
//   SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// YYYY-MM-DD for a date as seen in `tz`.
function ymdInTz(d: Date, tz: string): string {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d).reduce((o: any, x) => (o[x.type] = x.value, o), {});
  return `${p.year}-${p.month}-${p.day}`;
}

// UTC instant for the start (00:00) of a wall-clock day in `tz`.
function dayStartUtc(ymd: string, tz: string): Date {
  const naive = new Date(ymd + "T00:00:00");
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false, year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = dtf.formatToParts(naive).reduce(
    (o: any, x) => (x.type !== "literal" ? (o[x.type] = x.value, o) : o), {},
  );
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const offMin = Math.round((asUtc - naive.getTime()) / 60000);
  return new Date(naive.getTime() - offMin * 60000);
}

// Resolve a row's [start,end) instants. Prefer start_at/end_at; fall back to
// the legacy date_start + start_time/end_time interpreted in `tz`.
function rowSpan(r: any, tz: string): { start: Date; end: Date } | null {
  let start: Date | null = null, end: Date | null = null;
  if (r.start_at) start = new Date(r.start_at);
  if (r.end_at) end = new Date(r.end_at);
  if (!start && r.date_start && r.start_time) {
    start = dayStartUtc(r.date_start, tz);
    const [h, m] = r.start_time.split(":").map(Number);
    start = new Date(start.getTime() + (h * 60 + m) * 60000);
  }
  if (!start) return null;
  if (!end && r.date_start && r.end_time) {
    let e = dayStartUtc(r.date_start, tz);
    const [h, m] = r.end_time.split(":").map(Number);
    e = new Date(e.getTime() + (h * 60 + m) * 60000);
    if (e.getTime() <= start.getTime()) e = new Date(e.getTime() + 864e5);
    end = e;
  }
  if (!end) return null; // no duration → contributes 0
  return { start, end };
}

async function geminiInsight(summary: any, samples: string[]): Promise<{ insight: string; prompt: string; reply: string }> {
  const key = env("GEMINI_API_KEY");
  const sys =
    "你是一个私人时间管理复盘助手。根据用户昨天的时间记录，用一句简短的中文指出今天最容易做到的一个改进。" +
    "直接给建议，不要寒暄、不要前言、不要分点，只输出那一句话。";
  const prompt = JSON.stringify({ yesterday: summary, sample_activities: samples });
  // gemini-2.5-flash: this project's key has zero free quota on 2.0-flash
  // (429 limit:0); 2.5-flash works on the free tier (verified 2026-05-21).
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" +
    key;
  const body = {
    systemInstruction: { parts: [{ text: sys }] },
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 200 },
  };
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    const txt = j?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
    return { insight: txt, prompt, reply: JSON.stringify(j).slice(0, 4000) };
  } catch (e) {
    return { insight: "", prompt, reply: "error: " + String(e) };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const owner = env("OWNER_USER_ID");
    if (!owner) throw new Error("OWNER_USER_ID not set");
    const tz = env("OWNER_TZ", "America/New_York");

    const url = new URL(req.url);
    const forced = url.searchParams.get("date");
    const now = new Date();
    const yesterday = forced ||
      ymdInTz(new Date(now.getTime() - 864e5), tz);

    const dayStart = dayStartUtc(yesterday, tz);
    const dayEnd = new Date(dayStart.getTime() + 864e5);

    const sb = createClient(
      env("SUPABASE_URL"),
      env("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false } },
    );

    // Pull everything for the owner that could overlap the day. The legacy
    // date_start filter catches rows without start_at; start_at filter
    // catches the precise ones. Fetch generously and span-filter in code.
    const { data: byDate } = await sb.from("meetings")
      .select("id,name,category,start_at,end_at,date_start,start_time,end_time")
      .eq("owner", owner).eq("date_start", yesterday);
    const { data: byTs } = await sb.from("meetings")
      .select("id,name,category,start_at,end_at,date_start,start_time,end_time")
      .eq("owner", owner)
      .gte("start_at", dayStart.toISOString())
      .lt("start_at", dayEnd.toISOString());

    const seen = new Set<string>();
    const rows = [...(byDate || []), ...(byTs || [])].filter((r) => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });

    // Bucket minutes by category, clipped to the day window.
    const byCat: Record<string, number> = {};
    const named: { name: string; min: number }[] = [];
    let totalMin = 0;
    for (const r of rows) {
      const span = rowSpan(r, tz);
      if (!span) continue;
      const s = Math.max(span.start.getTime(), dayStart.getTime());
      const e = Math.min(span.end.getTime(), dayEnd.getTime());
      if (e <= s) continue;
      const min = Math.round((e - s) / 60000);
      const cat = r.category || "other";
      byCat[cat] = (byCat[cat] || 0) + min;
      totalMin += min;
      named.push({ name: r.name || cat, min });
    }
    named.sort((a, b) => b.min - a.min);

    const summary = {
      date: yesterday,
      total_minutes: totalMin,
      by_category_minutes: byCat,
      tracked_categories: Object.keys(byCat).length,
    };
    const samples = named.slice(0, 5).map((x) =>
      `${x.name} (${Math.round(x.min / 6) / 10}h)`
    );

    let insight = "", rawPrompt = "", rawReply = "";
    if (totalMin > 0) {
      const g = await geminiInsight(summary, samples);
      insight = g.insight;
      rawPrompt = g.prompt;
      rawReply = g.reply;
    } else {
      insight = "昨天没有记录到任何时间，今天可以试着开始记录一两件事。";
    }

    const { error } = await sb.from("daily_reviews").upsert({
      owner,
      date: yesterday,
      summary,
      insight,
      raw_prompt: rawPrompt,
      raw_reply: rawReply,
      created_at: new Date().toISOString(),
    }, { onConflict: "owner,date" });
    if (error) throw new Error("upsert daily_reviews failed: " + error.message);

    return new Response(
      JSON.stringify({ ok: true, date: yesterday, total_minutes: totalMin, by_category: byCat, insight }),
      { headers: { ...CORS, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: String(e) }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }
});
