# Cloud sync setup (Supabase) — ~5 minutes, one-time

The Aurora web app stays exactly as-is (look, animations, bilingual). This
just gives it a free cloud database so **any device that opens the page
shows the same data, synced automatically**. No middle layer needed —
Supabase is built for browsers to connect directly.

## Why a Supabase account is unavoidable

"Independent good-looking page + auto cloud sync + free" requires the data
to live in *some* cloud, which requires *one* cloud account. Supabase is the
least-effort one: its frontend key is designed to be public (unlike a Notion
token), so the static page can talk to it directly with no proxy server.

## Steps

1. Go to https://supabase.com → **Sign in** (GitHub / Google login is fine).
2. **New project**:
   - Name: `kaileme` (anything)
   - Database password: set any password — you do **not** need to remember
     it; the web app never uses it.
   - Region: closest to you. Create. Wait 1–2 min for it to provision.
3. Left sidebar → **SQL Editor** → New query → paste this and **Run**:

   ```sql
   create table if not exists meetings (
     id text primary key,
     type text, name text,
     date_start text, date_end text,
     venue_mode text, venue_detail text,
     role text, notes text,
     source_id text, created_at text
   );
   alter table meetings enable row level security;
   create policy "kaileme anon all" on meetings
     for all to anon using (true) with check (true);
   ```

   (The policy line lets the page's public key read/write this one table.
   Without it Supabase blocks everything by default and the page would
   connect but show/save nothing.)

4. Left sidebar → **Project Settings** (gear) → **API**. Copy two values:
   - **Project URL** — looks like `https://abcd1234.supabase.co`
   - **anon public** key (the long `eyJ...` string under "Project API keys",
     the one labelled **anon / public** — NOT the `service_role` one)

5. Open the web app `https://flkfz3.github.io/kaileme/` → **Settings** tab →
   under **Cloud sync (Supabase)** paste:
   - Project URL → "Supabase Project URL"
   - anon public key → "Supabase anon public key"
   - Click **Save settings**

6. Click **⬆ Upload local data to cloud** once — this pushes whatever you
   already recorded in the browser up to the cloud.

Done. From now on every add/edit/delete goes to the cloud, and opening the
page on any device (phone, another laptop) pulls the latest automatically.

## What this means for privacy

- The **anon public key is meant to be public** — it's safe to have it in
  the page; that is Supabase's intended design. Security is enforced by the
  table policy, not by hiding the key.
- For simplicity this setup uses a permissive policy: **anyone who knows
  both your Project URL and anon key could read/write this `meetings`
  table.** For low-sensitivity data (your own meeting log) this is an
  accepted trade-off and is how most personal single-user apps start.
- If you ever want it locked to only you, that requires Supabase Auth
  (email login + a per-user policy) — more setup; can be added later.
- Your meeting data is **not** in the public GitHub repo. Only `index.html`
  is public; it contains no URL or key (you paste those into the app at
  runtime, stored in your browser).

## Troubleshooting

- Page connects but list is empty / save does nothing → the SQL policy in
  step 3 wasn't run (or RLS is on without the policy). Re-run step 3.
- "Cloud sync error — check Supabase URL / key" toast → the URL or anon key
  is wrong, or you pasted the `service_role` key instead of `anon`.
- Want to start over → in Supabase SQL Editor: `delete from meetings;`
- The web app still works fully **without** Supabase (data stays in that
  one browser); Supabase only adds the cross-device cloud sync.
