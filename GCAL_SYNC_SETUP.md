# Google Calendar → Supabase auto-sync (backend, hands-free)

A Supabase Edge Function (`supabase/functions/sync-gcal/index.ts`) pulls your
Google Calendar on a schedule, keeps keyword-matching events, and writes them
into the `meetings` table tagged to your account. Fully hands-free once set
up — you never click anything. Code is already written; this is the one-time
config. It is the heaviest setup in this project; if it gets too fiddly, say
"switch to web semi-auto" and I'll downgrade you (only needs Part A then).

Re-running is safe: events are deduped by id `gcal:<eventId>`.

---

## Part A — Google OAuth client + Calendar API

1. https://console.cloud.google.com/ → your `kaileme` project (or any project).
2. Enable Calendar API:
   `https://console.cloud.google.com/apis/library/calendar-json.googleapis.com`
   → **Enable**.
3. Consent screen: `https://console.cloud.google.com/auth/overview`
   → External → app name `kaileme`, your email → Save and Continue through
   → add **your own Gmail** under Test users → Save.
4. Create OAuth client:
   `https://console.cloud.google.com/apis/credentials`
   → Create Credentials → **OAuth client ID** → Application type **Web
   application** → name `kaileme-gcal`.
   - **Authorized redirect URIs** → ADD URI →
     `https://developers.google.com/oauthplayground`
     (exactly this — it's how we'll mint the refresh token next)
   - Create. Copy the **Client ID** and **Client secret**.

## Part B — Get a refresh token (via Google OAuth Playground)

1. Open https://developers.google.com/oauthplayground
2. Top-right ⚙ (gear) → check **Use your own OAuth credentials** → paste the
   **Client ID** and **Client secret** from Part A → Close.
3. Left "Step 1" → in the "Input your own scopes" box paste:
   `https://www.googleapis.com/auth/calendar.readonly`
   → **Authorize APIs** → sign in with **your Google account** → Allow.
4. "Step 2" → click **Exchange authorization code for tokens**.
5. Copy the **Refresh token** value (a long string). This is one-time and
   long-lived — keep it; it goes into Supabase next.

## Part C — Deploy the Edge Function (Supabase dashboard, no CLI needed)

1. Supabase → left sidebar **Edge Functions** → **Create a function** (or
   "Deploy a new function") → name it exactly **`sync-gcal`**.
2. Paste the entire contents of `supabase/functions/sync-gcal/index.ts`
   (from this repo) into the editor → **Deploy**.
3. Function settings → turn **OFF "Verify JWT"** (a.k.a. "Enforce JWT" /
   "JWT verification"). The cron call carries no user token; with JWT
   verification on it would 401. This function takes no user input — it only
   reads your own calendar and writes your own rows — so this is fine.

## Part D — Set the secrets

Supabase → **Edge Functions → Secrets** (or Project Settings → Edge
Functions → Manage secrets). Add:

| Secret | Where to get it |
|---|---|
| `GOOGLE_CLIENT_ID` | Part A step 4 |
| `GOOGLE_CLIENT_SECRET` | Part A step 4 |
| `GOOGLE_REFRESH_TOKEN` | Part B step 5 |
| `OWNER_USER_ID` | Supabase → **Authentication → Users** → click your account → copy **User UID** (a UUID) |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are normally auto-injected into
Edge Functions — you usually do **not** need to set them. If a test run
errors that they're missing, add them too: URL = your project URL;
service_role key = Project Settings → API → **`service_role` secret key**
(the secret one, only ever lives here in the backend, never in the web app).

Optional tuning secrets (defaults are fine):
`GCAL_KEYWORDS` (default `meeting,seminar,conference,talk,workshop`),
`GCAL_DAYS_BACK` (default `180`), `GCAL_CALENDAR` (default `primary`).

## Part E — Test once, then schedule

1. **Test**: on the function's page click **Invoke** / **Run** (or
   `curl -X POST https://<project>.supabase.co/functions/v1/sync-gcal`).
   Expect JSON like `{"ok":true,"scanned":N,"upserted":M}`. Open the web app
   (logged in) → your calendar meetings should now appear.
2. **Schedule**: Supabase → **Edge Functions → Schedules** (newer UI) →
   add a schedule for `sync-gcal`, cron `0 7 * * *` (every day 07:00 UTC) —
   adjust as you like. (If there's no Schedules tab: Database → **Cron** →
   create a job that POSTs the function URL on that cron expression.)

Done. From then on it pulls your calendar daily into your account; any device
you log into shows the synced meetings.

---

## Troubleshooting

- Test returns `google token refresh failed` → wrong client id/secret, or the
  refresh token wasn't minted with the calendar.readonly scope / from the
  same client. Redo Part B.
- `{"ok":true,"scanned":N,"upserted":0}` → events were fetched but none
  matched a keyword. Adjust `GCAL_KEYWORDS`, or check your event titles.
- 401 when the cron fires → "Verify JWT" still on (Part C step 3).
- Meetings appear in DB but not in the web app → `OWNER_USER_ID` doesn't
  match your logged-in account's UID. Re-copy it from Authentication → Users.
- Want to stop it → delete the schedule (Part E step 2); the function and
  data stay.
- Downgrade to web semi-auto (only Part A needed, no refresh token, no
  function) → tell me and I'll switch the app over.
