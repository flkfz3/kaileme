# Kai Le Me — Deploy + Google Calendar setup

The auto-import-from-Google-Calendar feature needs two things that a locally
double-clicked file cannot provide:

1. The page must be served from an **https domain** (GitHub Pages, free, is
   enough) — Google does not allow OAuth login from `file://`.
2. You must create an **OAuth Client ID** in the Google Cloud Console and paste
   it into the app.

All one-time, ~15 minutes. After that each use is just: Connect → Pull.

The app UI is bilingual (English / 中文) with a one-click toggle in the
top-right; the default is English.

---

## Step 1: GitHub Pages (get the https URL)

The repository is already created and pushed (`flkfz3/kaileme`). You only need
to enable Pages:

1. Repo → **Settings** → left sidebar **Pages**
2. Source: **Deploy from a branch**, Branch `main`, folder `/ (root)` → **Save**
3. Wait 1–2 min, refresh; the URL appears at the top:
   ```
   https://flkfz3.github.io/kaileme/
   ```
   Open it — you should see the app.

> A free-account **public** repo is required for Pages. Your meeting data is
> never in the repo; it lives only in your browser's localStorage. The Client
> ID is also stored only locally.

---

## Step 2: Create the Google OAuth Client ID

1. Open https://console.cloud.google.com/ and sign in.
2. Top project dropdown → **New Project** → name it (e.g. `kaileme`) → Create →
   switch to that project.
3. Enable the Calendar API:
   - Left menu → **APIs & Services → Library**
   - Search `Google Calendar API` → open it → **Enable**
4. Configure the consent screen:
   - Left → **OAuth consent screen**
   - User Type **External** → Create
   - App name `kaileme`, your email for support + developer contact →
     Save and Continue
   - Scopes page → Save and Continue (add nothing)
   - **Test users** → Add Users → add **your own Gmail address** →
     Save and Continue
   - Leave it in "Testing" status (no review needed; your own account works)
5. Create the Client ID:
   - Left → **Credentials → Create Credentials → OAuth client ID**
   - Application type **Web application**
   - Name `kaileme-web`
   - **Authorized JavaScript origins** → Add URI, exactly the Pages origin
     (domain only, no path, no trailing slash):
     ```
     https://flkfz3.github.io
     ```
   - Leave redirect URIs empty (token mode)
   - Create
6. Copy the **Client ID** shown
   (`1234567890-abc....apps.googleusercontent.com`).

---

## Step 3: Configure the app

1. Open `https://flkfz3.github.io/kaileme/`
2. Go to the **Settings** tab:
   - **OAuth Client ID**: paste the string from Step 2
   - **Keywords**: default `meeting,seminar,conference,talk,workshop`; an event
     whose title or description contains any of these is treated as a meeting
   - **Keyword → meeting-type mapping**: an event matching the left keyword is
     imported with the right type; unmatched → Other
   - Click **Save settings**
3. Go to the **Google Calendar** tab:
   - **Connect Google Calendar** → Google auth → pick your account → allow
     (read-only)
   - Pick a time range → **Pull & filter**
   - Events that match keywords are listed; ones already imported are flagged
     and unchecked by default (dedup by Google event ID — re-pulling never
     duplicates)
   - Check the ones you want → **Import selected** → they appear in **List**

---

## Daily use

- Open the Pages URL. Add / List / Stats work offline, no login needed.
- To sync the calendar: Google Calendar tab → Connect → Pull → check → Import.
  Safe to repeat (deduped).
- Data lives only in the current browser's localStorage. Switching browsers /
  clearing cache loses it → click **Export backup** periodically to save a json.
- Cross-device: **Import backup** the json on the other device.

---

## Privacy & permissions

- Scope requested is `calendar.readonly`: read-only, cannot modify/delete your
  events.
- Client ID and meeting records are stored only in your browser, never uploaded.
- Only `index.html` is public; it contains no data or secret.
- Disconnect: Google Calendar tab → **Disconnect** revokes the current token.

---

## Troubleshooting

- **Connect does nothing / origin error**: the Authorized JavaScript origin in
  Step 2.5 must exactly match the Pages domain (`https://flkfz3.github.io`, no
  `/kaileme/`, no trailing slash). Changes take a few minutes to propagate.
- **403 / access_denied**: your Gmail was not added under Test users in
  Step 2.4, or you signed in with a different account.
- **Pull fails 401/403**: token expired — Disconnect then Connect again.
- **Connect button greyed out on local `file://`**: expected; the Google
  feature only works on the https Pages URL. The manual-record part still works
  locally.
