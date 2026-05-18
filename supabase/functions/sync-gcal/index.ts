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
//   GCAL_DAYS_BACK  how many days back to scan, default "3650" (~10 years)
//   GCAL_CALENDAR   calendar id, default "primary"

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;

// Title/keyword -> meeting type. Order matters; first match wins.
// Rule (per user): ONLY an event whose title is *exactly* "lab meeting"
// is the real lab meeting (组会). "Magdy's lab meeting", "meet with vet",
// etc. are NOT — anything else that mentions meet/meeting is a project
// meeting. talk / colloquium / seminar all count as a seminar.
function mapType(title: string, hay: string): string {
  const t = title.trim().toLowerCase();
  if (t === "lab meeting") return "组会";
  if (hay.includes("seminar") || hay.includes("colloquium") ||
      hay.includes("talk")) return "seminar";
  if (hay.includes("conference")) return "conference";
  if (hay.includes("meet")) return "Project meeting"; // meet & meeting
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
    type: mapType(ev.summary || "", hay),
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

// The web app calls this cross-origin (GitHub Pages -> *.supabase.co), so
// every response needs CORS headers and the preflight OPTIONS must be
// answered, otherwise the browser blocks the call ("sync failed").
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }
  try {
    const owner = env("OWNER_USER_ID");
    if (!owner) throw new Error("OWNER_USER_ID not set");
    const kws = env("GCAL_KEYWORDS", "meet,zoom,seminar,conference,talk,colloquium,workshop")
      .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const daysBack = parseInt(env("GCAL_DAYS_BACK", "3650"), 10);
    const calOverride = env("GCAL_CALENDAR", "").trim();

    const token = await googleAccessToken();
    const timeMin = new Date(Date.now() - daysBack * 864e5).toISOString();
    const timeMax = new Date(Date.now() + 864e5).toISOString();

    // Enumerate the account's calendars and sync ALL of them (except the
    // read-only holiday calendars), so an event is picked up no matter which
    // calendar it lives on. GCAL_CALENDAR, if set, forces a single calendar.
    let calList: any[] = [];
    try {
      const cl = await fetch(
        "https://www.googleapis.com/calendar/v3/users/me/calendarList",
        { headers: { Authorization: "Bearer " + token } },
      );
      if (cl.ok) {
        calList = ((await cl.json()).items || []).map((c: any) => ({
          id: c.id, summary: c.summary, primary: !!c.primary,
        }));
      }
    } catch (_) { /* ignore */ }

    const isHoliday = (c: any) =>
      /holiday/i.test(c.id || "") || /holiday/i.test(c.summary || "");
    const calIds: string[] = calOverride
      ? [calOverride]
      : (calList.length
        ? calList.filter((c) => !isHoliday(c)).map((c) => c.id)
        : ["primary"]);

    let items: any[] = [];
    for (const cid of calIds) {
      let pageToken = "";
      do {
        const u = new URL(
          `https://www.googleapis.com/calendar/v3/calendars/${
            encodeURIComponent(cid)
          }/events`,
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
        if (!r.ok) {
          throw new Error("calendar list failed: " + (await r.text()));
        }
        const j = await r.json();
        items = items.concat(j.items || []);
        pageToken = j.nextPageToken || "";
      } while (pageToken && items.length < 5000);
      if (items.length >= 5000) break;
    }

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

    // Merge strategy — the WEBSITE is authoritative. New calendar events are
    // inserted. For events already synced before:
    //   - if the row was edited by the user in the app (edited = true) it is
    //     SKIPPED entirely — the calendar never overwrites a website edit
    //     (user's explicit rule: app edits win over everything);
    //   - otherwise objective fields (name / dates / venue) and the
    //     machine-derived `type` are refreshed from the calendar (so an
    //     untouched row that was misclassified by an old rule self-corrects),
    //     and `notes` is back-filled only when the stored note is empty.
    // Manually-created rows (non-"gcal:" ids) are never touched at all.
    let inserted = 0, updated = 0, skipped = 0;
    if (rows.length) {
      const ids = rows.map((r) => r.id);
      const { data: exist, error: e1 } = await sb.from("meetings")
        .select("id,notes,edited").in("id", ids);
      if (e1) throw new Error("select existing failed: " + e1.message);
      const exById = new Map(
        (exist || []).map((r: any) => [r.id, r]),
      );
      const fresh = rows.filter((r) => !exById.has(r.id));
      if (fresh.length) {
        const { error } = await sb.from("meetings").insert(fresh);
        if (error) throw new Error("insert failed: " + error.message);
        inserted = fresh.length;
      }
      for (const r of rows.filter((x) => exById.has(x.id))) {
        const ex = exById.get(r.id);
        if (ex && ex.edited === true) { skipped++; continue; }
        const patch: Record<string, unknown> = {
          name: r.name,
          date_start: r.date_start,
          date_end: r.date_end,
          venue_mode: r.venue_mode,
          venue_detail: r.venue_detail,
          type: r.type,
        };
        const cur = ex && ex.notes;
        if (!cur || String(cur).trim() === "") patch.notes = r.notes;
        const { error } = await sb.from("meetings").update(patch).eq("id", r.id);
        if (!error) updated++;
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        scanned: items.length,
        calendars: calIds.length,
        inserted,
        updated,
        skipped,
      }),
      { headers: { ...CORS, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: String(e) }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }
});
