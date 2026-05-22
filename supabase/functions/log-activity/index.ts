// Supabase Edge Function: log-activity
//
// Voice time-tracker ingest for "timelog". Receives a dictated transcript from
// an iOS "记一下" Shortcut, parses it into a categorized activity, and writes a
// row into the shared `meetings` table. The user's spoken words are NEVER lost:
// on any parse/LLM failure the raw transcript is still saved as a row.
//
// Pipeline: secret auth -> special "done/sleep" command -> cheap heuristic time
// parse -> Gemini parse (category/name, and time when the heuristic missed) ->
// close any open ongoing voice row -> insert.
//
// Auth: shared secret `TIMELOG_INGEST_SECRET` as `?key=` or `x-secret` header.
// Deploy with `--no-verify-jwt`.
//
// Required secrets:
//   TIMELOG_INGEST_SECRET, GEMINI_API_KEY, OWNER_USER_ID, OWNER_TZ,
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Verified working 2026-05-21: this project's API key has free_tier quota = 0
// for gemini-2.0-flash (429 RESOURCE_EXHAUSTED, limit:0), but gemini-2.5-flash
// returns 200 with a clean responseSchema JSON on the free tier. Hard-coded
// after probing the live key.
const GEMINI_MODEL = "gemini-2.5-flash";

const CATEGORIES = [
  "meeting", "sleep", "work", "study", "exercise",
  "commute", "eat", "leisure", "other",
];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// Wall-clock HH:MM of an instant in OWNER_TZ (same pattern as sync-gcal).
function toLocalHM(iso: string | null, tz: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d).reduce((o: any, x) => (o[x.type] = x.value, o), {});
  const h = p.hour === "24" ? "00" : p.hour;
  return h + ":" + p.minute;
}

// Wall-clock YYYY-MM-DD of an instant in OWNER_TZ.
function toLocalDate(iso: string | null, tz: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d).reduce((o: any, x) => (o[x.type] = x.value, o), {});
  return `${p.year}-${p.month}-${p.day}`;
}

// Chinese numeral to int for hours 0..24 (一二三..十..二十三 + plain digits).
function cnNum(s: string): number | null {
  s = s.trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const d: Record<string, number> = {
    零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6,
    七: 7, 八: 8, 九: 9, 十: 10,
  };
  if (s in d) return d[s];
  // 十X / X十 / X十Y
  const m = s.match(/^([一二三四五六七八九]?)十([一二三四五六七八九]?)$/);
  if (m) {
    const tens = m[1] ? d[m[1]] : 1;
    const ones = m[2] ? d[m[2]] : 0;
    return tens * 10 + ones;
  }
  return null;
}

type TimeParse = { start_at: string | null; end_at: string | null } | null;

// Cheap, LLM-free time extraction. Returns absolute ISO instants anchored on
// spoken_at, or null when no confident time is found. Covers:
//   "刚跑了30分钟" / "跑步半小时" / "for 30 minutes" / "30 min"  -> duration
//   "9点到10点" / "从9点到10点" / "9:00 to 10:00"               -> range
function heuristicTime(transcript: string, spokenAt: string): TimeParse {
  const t = transcript;
  const spoken = new Date(spokenAt);
  if (isNaN(spoken.getTime())) return null;

  // 1) Explicit hour range: "(从)?H(点|:MM)(到|-|至|到)H(点|:MM)"
  const rangeRe =
    /(?:从)?\s*([零一二三四五六七八九十两\d]{1,3})\s*(?:点|时|:|：)\s*([0-5]?\d)?\s*(?:分)?\s*(?:到|至|-|—|~|to)\s*([零一二三四五六七八九十两\d]{1,3})\s*(?:点|时|:|：)\s*([0-5]?\d)?\s*(?:分)?/i;
  const rm = t.match(rangeRe);
  if (rm) {
    const h1 = cnNum(rm[1]); const m1 = rm[2] ? parseInt(rm[2], 10) : 0;
    const h2 = cnNum(rm[3]); const m2 = rm[4] ? parseInt(rm[4], 10) : 0;
    if (h1 !== null && h2 !== null && h1 <= 24 && h2 <= 24) {
      // Anchor to spoken_at's local calendar day; keep the wall-clock offset
      // of spoken_at so the new instants land in the same UTC offset.
      const off = isoOffset(spokenAt);
      const day = localDayParts(spokenAt);
      if (day && off !== null) {
        const start = mkInstant(day, h1, m1, off);
        let end = mkInstant(day, h2, m2, off);
        // If end <= start, the range crossed midnight -> push end to next day.
        if (new Date(end).getTime() <= new Date(start).getTime()) {
          const d2 = new Date(end); d2.setUTCDate(d2.getUTCDate() + 1);
          end = d2.toISOString();
        }
        return { start_at: start, end_at: end };
      }
    }
  }

  // 2) Duration: "(跑了)?N(分钟|分|min|minutes|小时|个小时|hour|h)" or "半小时".
  let minutes: number | null = null;
  if (/半\s*(?:个)?\s*小时|half\s*(?:an?\s*)?hour/i.test(t)) minutes = 30;
  if (minutes === null) {
    const dm = t.match(
      /([零一二三四五六七八九十两\d]{1,4}(?:\.\d+)?)\s*(分钟|分|个?小时|小时|minutes?|mins?|hours?|hrs?|h)\b/i,
    );
    if (dm) {
      const raw = /^[\d.]+$/.test(dm[1]) ? parseFloat(dm[1]) : cnNum(dm[1]);
      if (raw !== null) {
        const unit = dm[2].toLowerCase();
        const isHour = /小时|hour|hr|^h$/.test(unit) ||
          unit === "h" || /个?小时/.test(dm[2]);
        minutes = isHour ? Math.round(raw * 60) : Math.round(raw);
      }
    }
  }
  if (minutes !== null && minutes > 0 && minutes <= 24 * 60) {
    // A bare duration means the activity just ended at spoken_at.
    const end = spoken.toISOString();
    const start = new Date(spoken.getTime() - minutes * 60000).toISOString();
    return { start_at: start, end_at: end };
  }

  return null;
}

// Numeric UTC offset (minutes) carried by an ISO string like ...-04:00 / ...Z.
function isoOffset(iso: string): number | null {
  const m = iso.match(/([+-])(\d{2}):?(\d{2})$/);
  if (m) {
    const sign = m[1] === "-" ? -1 : 1;
    return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
  }
  if (/[zZ]$/.test(iso)) return 0;
  return null;
}

// {y,mo,d} of the local wall-clock day encoded in the ISO string's own offset.
function localDayParts(iso: string): { y: number; mo: number; d: number } | null {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T/);
  if (!m) return null;
  return { y: +m[1], mo: +m[2], d: +m[3] };
}

// Build an ISO instant for a wall-clock H:M on day at UTC offset offMin.
function mkInstant(
  day: { y: number; mo: number; d: number },
  h: number,
  mi: number,
  offMin: number,
): string {
  // wall time minus offset = UTC
  const utc = Date.UTC(day.y, day.mo - 1, day.d, h, mi) - offMin * 60000;
  return new Date(utc).toISOString();
}

// Detect the special "I'm done / going to sleep" command. True only when the
// transcript is essentially just the marker word (no other activity content).
function isStopCommand(transcript: string): boolean {
  const t = transcript.trim();
  if (!/(结束|睡觉|睡了|stop|done|i'?m done|going to sleep)/i.test(t)) {
    return false;
  }
  // Remove the marker words + filler; if almost nothing meaningful is left,
  // it's a stop command rather than an activity named "睡觉" with a duration.
  const stripped = t
    .replace(/(结束|睡觉|睡了|stop|done|i'?m done|going to (bed|sleep)|了|啦|吧|now|了吧)/gi, "")
    .replace(/[\s，。,.!！、~]/g, "")
    .trim();
  return stripped.length === 0;
}

async function callGemini(
  transcript: string,
  spokenAt: string,
  tz: string,
): Promise<
  {
    name: string;
    category: string;
    start_at?: string | null;
    end_at?: string | null;
    tags?: string[];
    confidence: number;
  } | null
> {
  const key = env("GEMINI_API_KEY");
  if (!key) return null;
  const system =
    "你是一个时间记录解析器。用户口述了一件刚做完或正在做的事，请抽取：" +
    "name（活动名称，简洁，用用户的语言）、category（从枚举里选最贴切的一个）、" +
    "start_at 和 end_at（ISO8601，带 owner 时区偏移）、tags（可选细分标签数组）、" +
    "confidence（0-1）。时间推理规则：若用户说“刚/just now/刚刚”，表示活动在 spoken_at 结束；" +
    "若只给出时长（如“30分钟”“半小时”），则 end_at=spoken_at，start_at=spoken_at 减去该时长；" +
    "若给出明确的起止点（如“9点到10点”），按当天该时区的钟点输出；" +
    "若完全没有时间信息，start_at=spoken_at，end_at 留空（表示进行中）。" +
    "category 枚举：meeting, sleep, work, study, exercise, commute, eat, leisure, other。" +
    "只返回严格 JSON，不要额外文字。";
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{
      parts: [{
        text: transcript + " (spoken at " + spokenAt +
          ", owner timezone " + tz + ")",
      }],
    }],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          category: { type: "string", enum: CATEGORIES },
          start_at: { type: "string" },
          end_at: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          confidence: { type: "number" },
        },
        required: ["name", "category", "confidence"],
      },
    },
  };
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!r.ok) return null;
    const data = await r.json();
    const txt = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!txt) return null;
    const parsed = JSON.parse(txt);
    if (!parsed?.name || !parsed?.category) return null;
    if (!CATEGORIES.includes(parsed.category)) parsed.category = "other";
    return parsed;
  } catch (_) {
    return null;
  }
}

// Human-readable display for the Shortcut notification.
function makeDisplay(
  name: string,
  startAt: string | null,
  endAt: string | null,
  tz: string,
): string {
  if (startAt && endAt) {
    const a = toLocalHM(startAt, tz);
    const b = toLocalHM(endAt, tz);
    const mins = Math.round(
      (new Date(endAt).getTime() - new Date(startAt).getTime()) / 60000,
    );
    // Short durations read better as a duration; explicit clock for longer.
    if (mins > 0 && mins < 120) {
      const dur = mins % 60 === 0
        ? `${mins / 60}小时`
        : (mins >= 60 ? `${Math.floor(mins / 60)}小时${mins % 60}分` : `${mins}分钟`);
      return `${name} ${dur}`;
    }
    return `${name} ${a}–${b}`;
  }
  if (startAt) return `${name} ${toLocalHM(startAt, tz)} 起`;
  return name;
}

// Keyword → category fallback for when Gemini is unavailable (rate-limited or
// transient error). Covers the user's high-frequency activities so a row is
// never left uncategorised for the common cases. First match wins.
function heuristicCategory(transcript: string): string | null {
  const t = transcript.toLowerCase();
  const table: [RegExp, string][] = [
    [/开会|会议|组会|meeting|讨论|汇报|seminar|talk/, "meeting"],
    [/睡|觉|午睡|小憩|nap|sleep/, "sleep"],
    [/吃|饭|早餐|午餐|晚餐|早饭|午饭|晚饭|喝|餐|eat|lunch|dinner|breakfast/, "eat"],
    [/跑步|跑|健身|运动|锻炼|散步|走路|健走|球|游泳|run|gym|workout|exercise|walk/, "exercise"],
    [/通勤|开车|坐车|地铁|公交|路上|driv|commut|subway|bus/, "commute"],
    [/写代码|编程|工作|干活|做实验|code|coding|work|debug|实验/, "work"],
    [/看书|读|学习|复习|上课|听课|read|study|class|course|paper|论文/, "study"],
    [/看|玩|游戏|刷|休息|放松|电影|剧|game|relax|rest|movie|leisure/, "leisure"],
  ];
  for (const [re, cat] of table) if (re.test(t)) return cat;
  return null;
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
    const secret = env("TIMELOG_INGEST_SECRET");
    if (!secret) throw new Error("TIMELOG_INGEST_SECRET not set");
    const url = new URL(req.url);
    const given = url.searchParams.get("key") ||
      req.headers.get("x-secret") || "";
    if (given !== secret) {
      return new Response(JSON.stringify({ ok: false, error: "bad secret" }), {
        status: 401,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const owner = env("OWNER_USER_ID");
    if (!owner) throw new Error("OWNER_USER_ID not set");
    const tz = env("OWNER_TZ", "America/New_York");

    const raw = await req.text();
    // JSON is primary; accept a plain "SUBJECT:"-style line as a trivial
    // fallback so a misconfigured Shortcut still lands the transcript.
    let transcript = "", spokenAt = "";
    let name = "", category: string | null = "", startTime = "", endTime = "", notes = "";
    try {
      const j = JSON.parse(raw);
      transcript = (j.transcript || j.text || "").toString();
      spokenAt = (j.spoken_at || j.spokenAt || "").toString();
      name = (j.name || "").toString().trim();
      category = (j.category || "").toString().trim();
      startTime = (j.start_time || j.startTime || "").toString().trim();
      endTime = (j.end_time || j.endTime || "").toString().trim();
      notes = (j.notes || "").toString().trim();
    } catch (_) {
      const sm = raw.match(/^SUBJECT:[ \t]*(.*)$/im);
      transcript = sm ? sm[1].trim() : raw.trim();
    }
    transcript = transcript.trim();
    // Fall back to server-now when spoken_at is missing OR unparseable. iOS
    // Shortcuts can serialise a raw Date variable to a localized string
    // ("2026年5月22日 上午9:07") that new Date() can't read; since the user
    // logs in real time, now() is a safe anchor.
    if (!spokenAt || isNaN(new Date(spokenAt).getTime())) {
      spokenAt = new Date().toISOString();
    }
    if (!transcript && !name) {
      return new Response(
        JSON.stringify({ ok: false, error: "empty transcript and no name" }),
        { status: 400, headers: { ...CORS, "Content-Type": "application/json" } },
      );
    }

    const sb = createClient(
      env("SUPABASE_URL"),
      env("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false } },
    );

    // --- Manual structured mode: when the request carries `name` (and
    // optionally category/start_time/end_time/notes) we skip the LLM and
    // persist exactly what the user typed in the "手动记" Shortcut. Both
    // half-/full-width colons in HH:MM are accepted. Empty start_time uses
    // spoken_at; empty end_time means "still going".
    if (name) {
      const off = isoOffset(spokenAt);
      const day = localDayParts(spokenAt);
      if (off === null || !day) {
        return new Response(
          JSON.stringify({ ok: false, error: "bad spoken_at" }),
          { status: 400, headers: { ...CORS, "Content-Type": "application/json" } },
        );
      }
      const parseHM = (s: string): [number, number] | null => {
        const m = s.replace(/：/g, ":").match(/^(\d{1,2}):(\d{2})$/);
        if (!m) return null;
        const h = +m[1], mi = +m[2];
        if (h > 23 || mi > 59) return null;
        return [h, mi];
      };
      let manStart = spokenAt;
      const pSt = startTime ? parseHM(startTime) : null;
      if (pSt) manStart = mkInstant(day, pSt[0], pSt[1], off);
      let manEnd: string | null = null;
      const pEn = endTime ? parseHM(endTime) : null;
      if (pEn) {
        manEnd = mkInstant(day, pEn[0], pEn[1], off);
        if (new Date(manEnd).getTime() <= new Date(manStart).getTime()) {
          // cross-midnight (e.g. 23:00-01:00)
          const d2 = new Date(manEnd);
          d2.setUTCDate(d2.getUTCDate() + 1);
          manEnd = d2.toISOString();
        }
      }
      const inKaileme = category === "meeting";
      const id = "manual:" + crypto.randomUUID();
      const row = {
        id,
        name,
        category: category || null,
        tags: [],
        source: "manual",
        transcript: null,
        in_kaileme: inKaileme,
        start_at: manStart,
        end_at: manEnd,
        date_start: toLocalDate(manStart, tz),
        date_end: null,
        start_time: toLocalHM(manStart, tz),
        end_time: manEnd ? toLocalHM(manEnd, tz) : null,
        tz,
        type: inKaileme ? "其他" : null,
        venue_mode: null,
        venue_detail: null,
        role: null,
        notes: notes || null,
        owner,
        edited: true,
        created_at: new Date().toISOString(),
      };
      const { error } = await sb.from("meetings").insert(row);
      if (error) throw new Error("manual insert failed: " + error.message);
      const sHM = toLocalHM(manStart, tz);
      const eHM = manEnd ? toLocalHM(manEnd, tz) : null;
      const display = eHM ? `${name} ${sHM}–${eHM}` : `${name} ${sHM} 起`;
      return new Response(
        JSON.stringify({
          ok: true,
          action: "created",
          id,
          display,
          parsed: { name, category: row.category, start_at: manStart, end_at: manEnd, in_kaileme: inKaileme, via: "manual" },
        }),
        { headers: { ...CORS, "Content-Type": "application/json" } },
      );
    }

    // --- Special command: close the open row, insert nothing. ---
    if (isStopCommand(transcript)) {
      // Only auto-close genuine ongoing VOICE rows. Legacy meeting rows can
      // also have end_at NULL (they use the date/time columns instead), so we
      // must not match them — closing one would corrupt a real calendar entry.
      const { data } = await sb.from("meetings")
        .select("id,name,start_at")
        .eq("owner", owner)
        .eq("source", "voice")
        .is("end_at", null)
        .order("created_at", { ascending: false })
        .limit(1);
      const open = (data || [])[0];
      if (open) {
        await sb.from("meetings").update({
          end_at: spokenAt,
          end_time: toLocalHM(spokenAt, tz),
        }).eq("id", open.id);
        return new Response(
          JSON.stringify({
            ok: true,
            action: "closed",
            id: open.id,
            name: open.name,
            end_at: spokenAt,
            display: `已结束 ${open.name || ""}`.trim(),
          }),
          { headers: { ...CORS, "Content-Type": "application/json" } },
        );
      }
      // Nothing open — graceful no-op.
      return new Response(
        JSON.stringify({ ok: true, action: "noop", display: "没有进行中的记录" }),
        { headers: { ...CORS, "Content-Type": "application/json" } },
      );
    }

    // --- Heuristic time parse first (cheap). ---
    const heur = heuristicTime(transcript, spokenAt);

    // --- Gemini for name + category (and time if heuristic missed). ---
    const llm = await callGemini(transcript, spokenAt, tz);

    let tags: string[] = [];
    let startAt: string;
    let endAt: string | null;

    if (llm) {
      name = llm.name;
      category = llm.category;
      tags = Array.isArray(llm.tags) ? llm.tags : [];
      if (heur) {
        // Trust the deterministic heuristic for time over the LLM.
        startAt = heur.start_at!;
        endAt = heur.end_at;
      } else {
        startAt = (llm.start_at && !isNaN(new Date(llm.start_at).getTime()))
          ? new Date(llm.start_at).toISOString()
          : spokenAt;
        endAt = (llm.end_at && !isNaN(new Date(llm.end_at).getTime()))
          ? new Date(llm.end_at).toISOString()
          : null;
      }
    } else {
      // Gemini failed — never lose the words. Save raw transcript as name,
      // use the heuristic time if we got one, and fall back to a keyword
      // category guess so common activities still classify.
      name = transcript;
      category = heuristicCategory(transcript);
      if (heur) {
        startAt = heur.start_at!;
        endAt = heur.end_at;
      } else {
        startAt = spokenAt;
        endAt = null;
      }
    }

    const inKaileme = category === "meeting";

    // --- Start-marker close: close the most recent open voice/manual row. ---
    const { data: openRows } = await sb.from("meetings")
      .select("id")
      .eq("owner", owner)
      .eq("source", "voice")
      .is("end_at", null)
      .order("created_at", { ascending: false })
      .limit(1);
    const openId = (openRows || [])[0]?.id;
    if (openId) {
      await sb.from("meetings").update({
        end_at: startAt,
        end_time: toLocalHM(startAt, tz),
      }).eq("id", openId);
    }

    const id = "voice:" + crypto.randomUUID();
    const row: Record<string, unknown> = {
      id,
      source: "voice",
      transcript,
      in_kaileme: inKaileme,
      category,
      tags,
      name,
      start_at: startAt,
      end_at: endAt,
      date_start: toLocalDate(startAt, tz),
      start_time: toLocalHM(startAt, tz),
      end_time: endAt ? toLocalHM(endAt, tz) : null,
      tz,
      type: inKaileme ? "其他" : null,
      owner,
      created_at: new Date().toISOString(),
    };

    const { error } = await sb.from("meetings").insert(row);
    if (error) throw new Error("insert failed: " + error.message);

    return new Response(
      JSON.stringify({
        ok: true,
        action: "created",
        id,
        display: makeDisplay(name, startAt, endAt, tz),
        parsed: {
          name, category, tags,
          start_at: startAt, end_at: endAt,
          in_kaileme: inKaileme,
          via: llm ? (heur ? "llm+heuristic" : "llm") : (heur ? "heuristic" : "raw"),
        },
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
