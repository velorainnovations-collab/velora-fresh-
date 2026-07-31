# Email sign-in, for owner, manager and head office

These people have real addresses, so Supabase can do the work: send a six digit
code instead of a password, email a reset link, and email a new account a link
to choose its own first password. Shop staff have none of this — their login id
is made from their phone and the owner hands the password over on WhatsApp.

Nothing here needs a server of ours. The app calls Supabase's own endpoints:

| What the person does            | Endpoint                | In the app |
|---------------------------------|-------------------------|------------|
| Email me a code instead         | `POST /auth/v1/otp`     | `VFSync.sendLoginCode` |
| Types the six digits            | `POST /auth/v1/verify`  | `VFSync.verifyLoginCode` |
| Forgot password                 | `POST /auth/v1/recover` | `VFSync.sendRecovery` |
| Follows the link in the email   | session in the url      | `VFSync.adoptRecoverySession` |
| Chooses a new password          | `PUT /auth/v1/user`     | `VFSync.setOwnPassword` |
| Owner adds them with no password| `POST /auth/v1/invite`  | the `create-user` function |

## Four settings in Supabase

Without these the buttons are there but nothing arrives.

**1. Authentication → URL Configuration**

* **Site URL** — the Vercel URL
* **Redirect URLs** — the Vercel URL, and `http://localhost:8080` for local work

Every link in every email comes back to one of these. Supabase refuses to send
people anywhere else, which is also why a stolen link cannot be pointed at
another site.

**2. Authentication → Email Templates → Magic Link**

Supabase's stock template sends a link. We ask for a code, so the template has
to contain the token:

```
Your Velora Fresh code is {{ .Token }}

It is good for a few minutes. If you did not ask for it, ignore this email.
```

Leave `{{ .ConfirmationURL }}` out — a link and a code in the same email only
confuses people.

**3. Authentication → Email Templates → Invite**

This is the one a new manager gets. The stock wording is fine; the link must
stay as `{{ .ConfirmationURL }}`. They land on the sign-in screen, which reads
the session out of the url and asks them to choose a password.

**4. Authentication → SMTP Settings**

Supabase's built-in sender is rate limited to a handful of emails an hour and
is meant for testing. Before this carries daily use, put a real sender behind
it — Resend's free tier is enough:

1. Sign up at resend.com and verify the domain you send from
2. Create an API key
3. In Supabase: SMTP host `smtp.resend.com`, port `465`, user `resend`,
   password the API key, sender `desk@yourdomain`

Until that is done, treat the code login as working but fragile: a few tries in
a row will be silently dropped.

## What the app does with a link

The reset and invite emails come back with `#access_token=...&type=recovery`
(or `type=invite`) on the end of the url. `adoptRecoverySession()` takes the
session out of the fragment, saves it, and strips it from the address bar so
the token is not left behind in browser history.

That session is good for setting a password and nothing else in practice: the
app still calls `whoami()` afterwards, and an account with no `app_users` row
is shown the door regardless of how it signed in.

## When somebody says "it says I am not an owner"

The screen and the `create-user` function decide separately, and they can
disagree — the screen shows the row it reads for your signed-in id, the
function reads the same row with the service key. If they ever disagree, the
row is missing or belongs to a different id. Run this in the SQL editor:

```sql
select u.id, u.email, a.role, a.active
from auth.users u
left join app_users a on a.id = u.id
order by u.created_at;
```

A `null` role means that sign-in has no row, and the fix is to give it one:

```sql
insert into app_users (id, full_name, role)
select id, 'Your name', 'owner' from auth.users where email = 'you@example.com'
on conflict (id) do update set role = 'owner', active = true;
```

Rows in `app_users` whose id matches nothing in `auth.users` are leftovers from
a hand-written insert. They show up in the Users list and can be deleted.
