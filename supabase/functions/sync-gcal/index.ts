// Supabase Edge Function: sync-gcal
// Pulls the user's Google Calendar events, keeps the ones whose title or
// description matches a keyword, maps them to the `meetings` schema, and
// upserts them into Supabase scoped to one owner. Deduped by source_id
// (which is also the row id: "gcal:<eventId>"), so re-running never
// duplicates. Designed to be invoked on a cron schedule.
//
// Required secrets (set via: supabase secrets set KEY=value, or in the
// dashboard → Project Settings → Edge Functions → Secrets):
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET
//   GOOGLE_REFRESH_TOKEN      (one-time, via OAuth Playground — see GCAL_SYNC_SETUP.md)
//   OWNER_USER_ID             (your Supabase Auth user UUID — Authentication → Users)
//   SUPABASE_URL              (auto-injected by Supabase; set manually if needed)
//   SUPABASE_SERVICE_ROLE_KEY (auto-injected; or copy from API settings)
// Optional:
//   GCAL_KEYWORDS   comma-separated, default "meeting,seminar,conference,talk,workshop"
//   GCAL_DAYS_BACK  how many days back to scan, default "180"
//   GCAL_CALENDAR   calendar id, default "primary"

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;

// keyword -> meeting type, mirrors the web app's default mapping
const TYPE_MAP: [string, string][] = [
  ["seminar", "seminar"],
  ["conference", "conference"],
  ["talk", "组内报告"],
  ["lab meeting", "组会"],
  ["group meeting", "组会"],
];

function mapType(hay: string): string {
  for (const [k, t] of TYPE_MAP) if (hay.includes(k)) return t;
  return "其他";
}

async function googleAccessToken(): Promise<string> {
  const body = new URLSearchParams({
    client_id: env("GOOGLE_CLIENT_ID"),
    client_secret: env("GOOGLE_CLIENT_SECRET"),
    refresh_token: env("GOOGLE_REFRESH_TOKEN"),
    grant_type: "refresh_token",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) throw new Error("google token refresh failed: " + (await r.text()));
  return (await r.json()).access_token as string;
}

function rowFromEvent(ev: any, owner: string) {
  const start = ev?.start?.date || ev?.start?.dateTime || "";
  const end = ev?.end?.date || ev?.end?.dateTime || "";
  const ds = start.slice(0, 10);
  let de = end.slice(0, 10);
  if (ev?.end?.date && de && de !== ds) {
    const d = new Date(de);
    d.setDate(d.getDate() - 1); // all-day end is exclusive
    de = d.toISOString().slice(0, 10);
  }
  const hay = ((ev.summary || "") + " " + (ev.description || "")).toLowerCase();
  const loc = (ev.location || "").trim();
  const online = !loc || /zoom|meet\.google|teams|webex/i.test(loc);
  return {
    id: "gcal:" + ev.id,
    type: mapType(hay),
    name: ev.summary || "(no title)",
    date_start: ds || null,
    date_end: de && de !== ds ? de : null,
    venue_mode: loc ? (online ? "线上" : "线下") : "线上",
    venue_detail: loc || null,
    role: null,
    notes: (ev.description || "").slice(0, 500) || null,
    source_id: "gcal:" + ev.id,
    created_at: new Date().toISOString(),
    owner,
  };
}

Deno.serve(async () => {
  try {
    const owner = env("OWNER_USER_ID");
    if (!owner) throw new Error("OWNER_USER_ID not set");
    const kws = env("GCAL_KEYWORDS", "meeting,seminar,conference,talk,workshop")
      .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const daysBack = parseInt(env("GCAL_DAYS_BACK", "180"), 10);
    const cal = encodeURIComponent(env("GCAL_CALENDAR", "primary"));

    const token = await googleAccessToken();
    const timeMin = new Date(Date.now() - daysBack * 864e5).toISOString();
    const timeMax = new Date(Date.now() + 864e5).toISOString();

    let items: any[] = [];
    let pageToken = "";
    do {
      const u = new URL(
        `https://www.googleapis.com/calendar/v3/calendars/${cal}/events`,
      );
      u.searchParams.set("timeMin", timeMin);
      u.searchParams.set("timeMax", timeMax);
      u.searchParams.set("singleEvents", "true");
      u.searchParams.set("orderBy", "startTime");
      u.searchParams.set("maxResults", "250");
      if (pageToken) u.searchParams.set("pageToken", pageToken);
      const r = await fetch(u, {
        headers: { Authorization: "Bearer " + token },
      });
      if (!r.ok) throw new Error("calendar list failed: " + (await r.text()));
      const j = await r.json();
      items = items.concat(j.items || []);
      pageToken = j.nextPageToken || "";
    } while (pageToken && items.length < 2000);

    const rows = items
      .filter((ev) => {
        const hay = ((ev.summary || "") + " " + (ev.description || ""))
          .toLowerCase();
        return kws.some((k) => hay.includes(k));
      })
      .map((ev) => rowFromEvent(ev, owner));

    const sb = createClient(
      env("SUPABASE_URL"),
      env("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false } },
    );

    let upserted = 0;
    if (rows.length) {
      const { error } = await sb.from("meetings")
        .upsert(rows, { onConflict: "id" });
      if (error) throw new Error("upsert failed: " + error.message);
      upserted = rows.length;
    }

    return new Response(
      JSON.stringify({ ok: true, scanned: items.length, upserted }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: String(e) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
