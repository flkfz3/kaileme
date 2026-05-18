# Cloud sync setup (Supabase + login) — real privacy, free, auto-sync

The Aurora web app stays exactly as-is. This connects it to a free Supabase
cloud database **with a login**, so:

- **Auto cross-device sync, free.**
- **Real privacy**: data is tied to *your account*. Even if someone has the
  app URL and the public key, **without your login they cannot read or write
  a single row**. (This replaces the earlier "anyone with the key can read"
  trade-off — now it's a true per-account lock.)
- **Switching devices is just "log in"** — no more copying a key string
  around; email + password, which everyone understands.

You already created the project and ran the first table SQL. Do the rest in
this order (order matters — create your login *before* tightening security):

---

## 1. (Optional but recommended) Turn off email confirmation

So that signing up lets you log in immediately without waiting for a
confirmation email:

- Supabase → **Authentication** → **Sign In / Providers** (or **Settings**)
  → **Email** → turn **OFF** "Confirm email" / "Enable email confirmations"
  → Save.

(If you leave it on, after signing up you must click a link in an email
before you can log in. Off is simpler for a single personal user.)

## 2. Put the connection values into the app

Open `https://flkfz3.github.io/kaileme/?v=7` → **Settings** tab →
**Cloud sync (Supabase)**:

- **Supabase Project URL**: `https://kbcftsexzmxjtlljgcyi.supabase.co`
- **Supabase key**: `sb_publishable_KHDCXbLrlL6pQiLKhgfH-A_Fxxg5Un6`
- **Save settings**

A login screen will now appear (because cloud is configured).

## 3. Create your account

On that login screen → enter your email + a password → **Create account**.
(With step 1 done, it logs you in right away.) You are now signed in; your
data area appears.

## 4. Upload your existing local records

Settings tab → **⬆ Upload local data to cloud** (once). This pushes whatever
you had recorded in the browser into the cloud, tagged to your account.

## 5. Tighten security — run this in SQL Editor

Now that you have an account and are logged in, lock the table so **only a
logged-in owner can touch their own rows**. Supabase → **SQL Editor** →
New query → paste and **Run**:

```sql
-- add an owner column; new rows auto-belong to the logged-in user
alter table meetings add column if not exists owner uuid default auth.uid();
-- backfill any rows that have no owner yet to YOU (run while logged in via app;
-- if this returns 0 rows that's fine, the app fills owner on upload)
update meetings set owner = auth.uid() where owner is null;
-- remove the old "anyone with the key" policy
drop policy if exists "kaileme anon all" on meetings;
-- new policy: must be logged in AND can only see/edit your own rows
drop policy if exists "own rows" on meetings;
create policy "own rows" on meetings
  for all to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());
```

Note: the `update ... set owner = auth.uid()` line only works the way you
want if run from a context that has your user identity. Simpler and safer:
**do step 4 (Upload) first while logged in** — the app stamps every uploaded
row with your account automatically — then this SQL's `update` line just
mops up any strays (often 0).

After this runs, the anonymous/public key alone can no longer read or write
anything — every request must carry your login. Done.

---

## Daily use

- Open `https://flkfz3.github.io/kaileme/` on any device. Same browser as
  before → still logged in. New device / cleared cache → it shows the login
  screen; enter the same email + password → your data loads from the cloud.
- Add / edit / delete → synced to the cloud automatically, scoped to you.
- The app still works fully offline-ish per-browser if Supabase isn't
  configured, but the whole point now is the logged-in cloud.

## Privacy (the real version now)

- Data is row-locked to your account via Supabase Auth + RLS. Someone with
  the URL and public key but **no login gets nothing** — every read/write is
  rejected unless the request carries your authenticated session.
- The public key in the app settings is, by design, safe to be public; it no
  longer grants data access on its own.
- Only `index.html` is in the public GitHub repo — no URL, no key, no data,
  no password. You type the URL+key into the app (stored in your browser),
  and your password is never stored anywhere by the app (Supabase handles it,
  hashed).

## Troubleshooting

- Login screen never goes away after correct password → step 1 (email
  confirmation still on) or wrong password. Check Authentication → Users in
  Supabase to see if the account exists / is confirmed.
- "Sign-in failed" → wrong email/password, or account not created yet
  (use **Create account** first).
- After step 5, the app shows nothing even logged in → the `update owner`
  didn't tag your rows. Re-run step 4 (Upload) while logged in, or in SQL
  Editor: `update meetings set owner = (select id from auth.users limit 1);`
  (works because there's only one user — you).
- Start over: SQL Editor → `delete from meetings;`
