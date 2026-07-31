# Putting it live

The app is one static file. Any static host works; Vercel is the easiest
because it redeploys on every push with no configuration.

## Why Vercel here

* Free tier, and it deploys **private** repositories — the app should not be a
  public repo
* Every push to `main` goes live in under a minute
* Every branch and pull request gets its own preview URL, so a change can be
  checked before it reaches whoever is testing
* A custom domain later is a DNS record and nothing else

GitHub Pages was the alternative and is rejected: it needs the repository to be
public on the free plan, and this one holds the client's shop structure.

## First deploy

1. Push this repository to GitHub.
2. Go to <https://vercel.com>, **Sign up with GitHub**.
3. **Add New → Project**, pick the repository, **Import**.
4. Framework preset: **Other**. Leave Build Command and Output Directory empty
   — `index.html` is committed, so there is nothing to build on their side.
5. **Deploy**.

You get a URL like `https://velora-fresh.vercel.app`. Send that to whoever is
testing. Every later `git push` redeploys it automatically.

## Supabase, once you have the URL

Authentication → URL Configuration:

* **Site URL** — your Vercel URL
* **Redirect URLs** — add the Vercel URL, and `http://localhost:8080` for local
  work

Password sign-in works without this, but password resets and any future email
link will not.

## vercel.json

```json
"buildCommand": "python3 src/build.py",
"outputDirectory": "."
```

Vercel's image has python3, so `index.html` is rebuilt on every deploy rather
than trusting the committed copy, and cannot go stale. The app is one file at
the repository root, so the output directory is `.` — without that line Vercel
looks for a `public/` folder and the build fails.

**Do not put comments in that file.** JSON has none, and Vercel validates the
schema strictly: a `"//"` key fails the build with *"should NOT have additional
property"*. Explanations go here instead. `.github/workflows/ci.yml` rejects
unknown top-level keys so the mistake is caught before it reaches a deploy.

## The one rule

`index.html` is **generated**. Edit `src/template.html`, then:

```bash
npm run build     # regenerate index.html
npm test          # 25 smoke + 50 sync checks
git commit -am "..."
git push          # Vercel deploys
```

Pushing without rebuilding puts stale code live. `.github/workflows/ci.yml`
rebuilds on every push and fails the run if the committed `index.html` differs
from `src/template.html`, so the mistake is caught rather than shipped.

## What is safe to have in the repository

`src/config.js` holds the project URL and the **anon** key. Both belong in the
page: the anon key identifies the project and grants nothing on its own. Access
is decided by the row level security in `supabase/02_security.sql`, which is
tested by `supabase/test_security.sql`.

The **service_role** key bypasses every one of those policies. It must never be
in this repository, in `config.js`, or in a Vercel environment variable that the
browser can read.

## Giving your testers access

They cannot sign themselves up — an account with no `app_users` row sees
nothing. As owner, on Master → Users:

* **A manager, head office or another owner** — type their name and email and
  leave the password blank. The account is created and Supabase emails them a
  link to choose their own first password. See `docs/EMAIL.md` for the four
  settings that have to be in place before any email actually goes out.
* **Shop staff** — type their name and phone and set a password (the ↻ button
  suggests one). No email is sent; the panel that appears afterwards sends the
  login on WhatsApp. Their login id is built from their phone.

Give testers `admin` rather than `owner` unless they genuinely need to see
margins, payments and vendor bank details.

## Custom domain later

Vercel → Project → Settings → Domains → add e.g. `desk.velorafresh.com`, then
create the DNS record Vercel shows you. Add the new domain to Supabase's
redirect URLs at the same time.
