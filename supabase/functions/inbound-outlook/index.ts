// Supabase Edge Function: inbound-outlook
//
// Receives a forwarded Zoom recap email (POSTed by an Apps Script running
// on the user's Gmail, where her UGA Outlook auto-redirects matching mail),
// parses it, and either updates the same-day meeting row in `meetings` or
// creates a new one. The recap email's existence = the meeting really
// happened, so a record is ALWAYS produced.
//
// Auth: shared secret `INBOUND_SECRET` as `?key=` or `x-webhook-secret`.
// Deploy with `--no-verify-jwt`.
//
// Required secrets:
//   INBOUND_SECRET, OWNER_USER_ID, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-webhook-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// Read a top-level `KEY:` line from the plain-text payload Apps Script sends.
function field(raw: string, key: string): string {
  const m = raw.match(new RegExp("^" + key + ":[ \\t]*(.*)$", "im"));
  return m ? m[1].trim() : "";
}

// Strip HTML to a readable plain-text block. Newlines preserved at block
// boundaries; common entities decoded; whitespace collapsed.
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(
      // Preserve meaningful links inline as "text (url)". Only keep URLs
      // that point at a Zoom-owned destination — these are the "View
      // summary / recap" links the user actually needs. Drop the URL for
      // social / footer / logo anchors, keep only their visible text.
      /<a\b[^>]*\bhref\s*=\s*["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/gi,
      (_full, url, inner) => {
        const txt = inner.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
        if (!/zoom\.(us|com)/i.test(url)) return txt;
        if (!txt || txt === url) return url;
        return `${txt} (${url})`;
      },
    )
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function to24h(h: number, ap: string): number {
  const isPm = /p/i.test(ap);
  if (isPm && h < 12) return h + 12;
  if (!isPm && h === 12) return 0;
  return h;
}

// Parse subject + body. Returns the canonical meeting name, the date the
// meeting happened on, and the start time when the recap carries one.
function parseRecap(
  subject: string,
  bodyHtml: string,
  receivedISO: string,
): {
  rawName: string;
  date: string;
  startTime: string | null;
  tz: string | null;
} {
  // 1. Meeting name from subject (strip Fw:/FW: chains).
  const sc = subject.replace(/^(?:F[Ww]:\s*)+/, "").trim();
  let rawName = sc;
  let m: RegExpMatchArray | null;
  if ((m = sc.match(/^Meeting assets for (.+?)\s+are ready!$/))) {
    rawName = m[1].trim();
  } else if ((m = sc.match(/^(.+?)的会议摘要/))) {
    rawName = m[1].trim();
  }

  // 2. Date + time from body. All anchors run on the HTML-stripped text so
  // tags between markers (e.g. "<b>Sent:</b> Thursday, ...") never block a
  // match. Anchor order is most-specific first.
  const text = htmlToText(bodyHtml);
  let date = "";
  let startTime: string | null = null;
  // A. English Lab Meeting card: "Date: MM/DD/YYYY HH:MM AM/PM"
  if (
    (m = text.match(
      /Date:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i,
    ))
  ) {
    const [, mo, dd, yr, hh, mm, ap] = m;
    date = `${yr}-${pad(+mo)}-${pad(+dd)}`;
    startTime = `${pad(to24h(+hh, ap))}:${mm}`;
  } // B. English Project meeting banner: "<name> YYYY-MM-DD HH:MM AM/PM"
  else if (
    (m = text.match(
      /(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i,
    ))
  ) {
    const [, yr, mo, dd, hh, mm, ap] = m;
    date = `${yr}-${mo}-${dd}`;
    startTime = `${pad(to24h(+hh, ap))}:${mm}`;
  } // C. Chinese: "以下项目的会议摘要： <name> (MM/DD/YYYY)" — date only
  else if (
    (m = text.match(
      /以下项目的会议摘要[：:][^()]*?\((\d{1,2})\/(\d{1,2})\/(\d{4})\)/,
    ))
  ) {
    const [, mo, dd, yr] = m;
    date = `${yr}-${pad(+mo)}-${pad(+dd)}`;
  } // D. Forwarded "Sent: <Day>, <Month> <D>, <Year> ..." header — for the
  // English variant whose body carries only a "View meeting recap" link
  // with no inline date. The Sent time is *after* the meeting, so we keep
  // only the date and leave start_time null.
  else if (
    (m = text.match(
      /Sent:\s*\w+,\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})\b/i,
    ))
  ) {
    const months: Record<string, number> = {
      january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
      july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
    };
    const [, mo, dd, yr] = m;
    date = `${yr}-${pad(months[mo.toLowerCase()])}-${pad(+dd)}`;
  } // E. Last-resort fallback: the wrapper's received date.
  else {
    date = (receivedISO || new Date().toISOString()).slice(0, 10);
  }

  return {
    rawName,
    date,
    startTime,
    tz: startTime ? "America/New_York" : null,
  };
}

// Map the raw name to a canonical type + canonical name. The classifier is
// deliberately conservative — anything unrecognized falls into "其他" with
// the name preserved (the user can re-classify in the app and the edit is
// preserved by the freeze rule).
function classify(
  rawName: string,
): { type: string; name: string } {
  const n = rawName.trim();
  const l = n.toLowerCase();
  if (/^(bdal\s+)?lab\s+meeting$/i.test(n)) {
    return { type: "组会", name: "lab meeting" };
  }
  if (/professor\s+xiaowei\s+yu/i.test(n)) {
    return { type: "Project meeting", name: "Meeting with Professor Xiaowei Yu" };
  }
  if (/^meeting with /i.test(n) || /^meet with /i.test(n)) {
    return { type: "Project meeting", name: n };
  }
  if (l.includes("seminar") || l.includes("colloquium") || l.includes("talk")) {
    return { type: "seminar", name: n };
  }
  if (l.includes("conference")) {
    return { type: "conference", name: n };
  }
  return { type: "其他", name: n };
}

// Find an existing same-day meeting row that this recap should attach to.
// Excludes other `mail:` rows from the candidate pool (the recap should
// never match itself). Prefers a name that contains, or is contained by,
// the recap's canonical name (case-insensitive).
async function findSameDayMatch(
  sb: any,
  owner: string,
  date: string,
  canonical: string,
): Promise<
  {
    id: string;
    name: string;
    notes: string | null;
    start_time: string | null;
    end_time: string | null;
  } | null
> {
  const { data } = await sb.from("meetings")
    .select("id,name,notes,start_time,end_time")
    .eq("owner", owner)
    .eq("date_start", date)
    .or("id.like.gcal:%,id.like.manual:%");
  if (!data || !data.length) return null;
  const cn = canonical.toLowerCase();
  for (const r of data) {
    const rn = (r.name || "").toLowerCase();
    if (!rn) continue;
    if (rn === cn || rn.includes(cn) || cn.includes(rn)) return r;
  }
  return null;
}

const OPEN = "=== Zoom recap (auto, do not edit between markers) ===";
const CLOSE = "=== /Zoom recap ===";

// Cut the forwarded-mail noise out of the recap text so only what the user
// cares about lands in notes: the AI summary section when present, or just
// the meaningful "View summary"/"… (zoom.us/launch/…)" line when the email
// is only a link. Drop From/Sent/To/Subject headers, "[EXTERNAL SENDER]"
// warnings, the Zoom logo/social/footer URLs, and everything below the
// "Thank you, Zoom Support Team" / "© Zoom Communications" / "Enable
// summaries" fold.
function extractRecap(text: string): string {
  let t = text;
  t = t.replace(/^(From|Sent|To|Subject)\s*:[^\n]*\n/gm, "");
  t = t.replace(/^\s*\[EXTERNAL SENDER[^\]]*\]\s*$/gm, "");
  t = t.replace(
    /^\s*(?:Zoom\.com\s*)?\(?https?:\/\/(?:zoom\.com|support\.zoom\.us|blog\.zoom\.us|click\.zoom\.us|www\.linkedin\.com|twitter\.com|facebook\.com|youtube\.com)\/?\b[^\n]*\)?\s*$/gim,
    "",
  );
  t = t.replace(/^Meeting assets for [^\n]*are ready!\s*$/gm, "");
  const fold = t.search(
    /Thank you,\s*\n\s*Zoom Support Team|Enable summaries for meetings|©\s*\d{4}\s*Zoom\b|55 Almaden Blvd/,
  );
  if (fold > -1) t = t.slice(0, fold);
  return t.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

// Insert or replace the recap block inside an existing notes value. The
// recap goes BEFORE the existing notes (calendar invitations / user
// comments) — the recap is what the user actually wants to see, the
// invitation link is fallback context. Re-sends replace the block in place
// so duplicates don't stack.
function setRecapBlock(existing: string | null, recap: string): string {
  const block = `${OPEN}\n${recap}\n${CLOSE}`;
  const cur = (existing || "").trim();
  if (!cur) return block;
  const re = new RegExp(
    OPEN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
      "[\\s\\S]*?" +
      CLOSE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  // Strip any pre-existing block (possibly in the wrong position from an
  // older version) and reattach the fresh one at the FRONT.
  const stripped = cur.replace(re, "").trim();
  return stripped ? `${block}\n\n${stripped}` : block;
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

    const owner = env("OWNER_USER_ID");
    if (!owner) throw new Error("OWNER_USER_ID not set");

    const raw = await req.text();
    // Accept either Apps Script's plain-text convention or a JSON payload.
    let subject = "", from = "", received = "", msgId = "", bodyHtml = "";
    try {
      const j = JSON.parse(raw);
      subject = j.subject || j.Subject || "";
      from = j.from || j.From || "";
      received = j.receivedDateTime || j.received || "";
      msgId = j.internetMessageId || j.id || "";
      bodyHtml = j.bodyHtml || j.body || "";
    } catch (_) {
      subject = field(raw, "SUBJECT");
      from = field(raw, "FROM");
      received = field(raw, "RECEIVED");
      msgId = field(raw, "MSGID");
      const m = raw.match(/^BODYHTML:[ \t]*\n([\s\S]*)$/m);
      bodyHtml = m ? m[1] : "";
    }

    const parsed = parseRecap(subject, bodyHtml, received);
    const cls = classify(parsed.rawName);
    const recapText = extractRecap(htmlToText(bodyHtml)).slice(0, 10000);

    const sb = createClient(
      env("SUPABASE_URL"),
      env("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false } },
    );

    const match = await findSameDayMatch(sb, owner, parsed.date, cls.name);
    const mailId = "mail:" +
      hash(msgId || (from + "|" + subject + "|" + received) || raw);

    if (match) {
      // Update the calendar/manual row. The recap is authoritative for time —
      // overwrite when the recap carries one, leave the existing time alone
      // when it doesn't (the Chinese template has no time). Preserve every
      // other user-editable field; the freeze rule still protects them.
      const patch: Record<string, unknown> = {
        notes: setRecapBlock(match.notes, recapText),
      };
      if (parsed.startTime) {
        patch.start_time = parsed.startTime;
        patch.tz = parsed.tz;
        // Shift end_time by the same delta so the meeting's duration is
        // preserved when the start gets corrected (e.g. 16:00 → 11:05 with
        // a 17:00 end becomes 12:05, not a 6-hour ghost meeting).
        if (match.start_time && match.end_time) {
          const toMin = (hm: string) => {
            const [h, mm] = hm.split(":").map(Number);
            return h * 60 + mm;
          };
          const oldStart = toMin(match.start_time);
          const oldEnd = toMin(match.end_time);
          const newStart = toMin(parsed.startTime);
          const dur = oldEnd - oldStart;
          if (dur > 0) {
            const newEnd = ((newStart + dur) % 1440 + 1440) % 1440;
            patch.end_time = `${pad(Math.floor(newEnd / 60))}:${pad(newEnd % 60)}`;
          }
        }
      }
      const { error } = await sb.from("meetings").update(patch).eq("id", match.id);
      if (error) throw new Error("update failed: " + error.message);
      return new Response(
        JSON.stringify({
          ok: true,
          action: "updated",
          id: match.id,
          name: match.name,
          date: parsed.date,
          startTime: parsed.startTime,
        }),
        { headers: { ...CORS, "Content-Type": "application/json" } },
      );
    }

    // No same-day match — create a new row keyed by message id so a re-send
    // is idempotent (upsert on the same id, no duplicate).
    const { error } = await sb.from("meetings").upsert({
      id: mailId,
      type: cls.type,
      name: cls.name,
      date_start: parsed.date,
      date_end: null,
      start_time: parsed.startTime,
      end_time: null,
      tz: parsed.tz,
      venue_mode: "线上",
      venue_detail: "Zoom",
      role: null,
      notes: setRecapBlock(null, recapText),
      source_id: msgId || null,
      created_at: new Date().toISOString(),
      owner,
      edited: false,
    }, { onConflict: "id" });
    if (error) throw new Error("upsert failed: " + error.message);

    return new Response(
      JSON.stringify({
        ok: true,
        action: "created",
        id: mailId,
        name: cls.name,
        type: cls.type,
        date: parsed.date,
        startTime: parsed.startTime,
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
