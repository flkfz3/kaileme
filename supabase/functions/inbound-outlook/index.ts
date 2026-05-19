// Supabase Edge Function: inbound-outlook  (STUB — plumbing only)
//
// Receives a forwarded Outlook "meeting summary" email (POSTed by a Power
// Automate flow, or by an inbound-parse service behind an auto-forward rule)
// and stores it verbatim as a `mail:<hash>` row in `meetings`, so we can:
//   1. confirm the whole pipe (mailbox → feeder → function → DB) works, and
//   2. capture REAL sample emails to design the parser + calendar match key.
// It deliberately does NOT parse, classify, or match yet. Once we have real
// samples those steps replace the verbatim dump.
//
// Auth: a shared secret (NOT a Supabase JWT — deploy with --no-verify-jwt).
// Send it as `?key=<secret>` or header `x-webhook-secret: <secret>`.
//
// Required secrets (supabase secrets set KEY=value):
//   INBOUND_SECRET            shared secret the feeder must present
//   OWNER_USER_ID             Supabase Auth user UUID (same as sync-gcal)
//   SUPABASE_URL              auto-injected
//   SUPABASE_SERVICE_ROLE_KEY auto-injected

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-webhook-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Small stable string hash → short base36, for a dedupe-friendly row id.
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function jget(o: any, ...keys: string[]): string {
  for (const k of keys) {
    const v = k.split(".").reduce((a: any, p) => (a == null ? a : a[p]), o);
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "POST only" }), {
      status: 405,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  try {
    const secret = env("INBOUND_SECRET");
    if (!secret) throw new Error("INBOUND_SECRET not set");
    const url = new URL(req.url);
    const given = url.searchParams.get("key") ||
      req.headers.get("x-webhook-secret") || "";
    if (given !== secret) {
      return new Response(JSON.stringify({ ok: false, error: "bad secret" }), {
        status: 401,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const raw = await req.text();
    let payload: any = null;
    try {
      payload = JSON.parse(raw);
    } catch (_) {
      payload = null; // not JSON — keep raw text only
    }

    const subject = payload ? jget(payload, "subject", "Subject") : "";
    const from = payload
      ? jget(
        payload,
        "from",
        "From",
        "sender",
        "from.emailAddress.address",
        "sender.emailAddress.address",
      )
      : "";
    const received = payload
      ? jget(payload, "received", "receivedDateTime", "ReceivedDateTime", "date")
      : "";
    const dateStart = (received || new Date().toISOString()).slice(0, 10);
    const msgId = payload
      ? jget(payload, "internetMessageId", "id", "messageId", "InternetMessageId")
      : "";

    const id = "mail:" +
      hash(msgId || (from + "|" + subject + "|" + received) || raw);

    const dump = [
      "From: " + (from || "?"),
      "Subject: " + (subject || "?"),
      "Received: " + (received || "?"),
      "--- raw payload ---",
      raw.slice(0, 8000),
    ].join("\n");

    const sb = createClient(
      env("SUPABASE_URL"),
      env("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false } },
    );

    // Upsert by id so a re-sent / retried email doesn't pile up duplicates.
    const { error } = await sb.from("meetings").upsert({
      id,
      type: null,
      name: subject || "(outlook email)",
      date_start: dateStart,
      date_end: null,
      venue_mode: null,
      venue_detail: null,
      role: null,
      notes: dump,
      start_time: null,
      end_time: null,
      tz: null,
      source_id: msgId || null,
      created_at: new Date().toISOString(),
      owner: env("OWNER_USER_ID"),
      edited: false,
    }, { onConflict: "id" });
    if (error) throw new Error("upsert failed: " + error.message);

    return new Response(JSON.stringify({ ok: true, id }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
