# Roadmap

## Built

* Indent entry with the 6 pm / 9 pm / 11:30 pm window and late flagging
* Admin review — cut quantities, remove lines, accept
* Vendor groups and vendor master, bank details owner-only
* Orders per vendor group, shop-wise split, WhatsApp message preview, per-group confirm
* Rate entry clubbed into vendor blocks, with yesterday's rate and a >15% jump warning
* Packing per shop, including products the shop never indented
* Out for delivery → shop confirmation → invoice
* Invoice with the 4% commission inside the rate, no service line, no GST, print to A4
* Margin master — commission % per shop, selling margin % per shop per product
* Weekly accounts, Monday to Sunday, chain-level payments, oldest-bill-first partials
* Roles: Owner, Admin, Head office, Shop

### Backend, done

* Supabase Postgres behind the same `load()` / `save()` the screens always used
* Row level security on all 20 tables, with a test that fails if a table has none
* Vendor bank details in their own table, because a policy cannot hide a column
* Bill numbers issued inside a transaction by `next_bill_no()`
* Local-first sync: a queue in localStorage, so a bad signal at Koyambedu at 4 am
  delays the push and nothing else
* Hosted on Vercel, rebuilt from `src/template.html` on every push

### Logins, done

* Owner adds people from Master → Users; no SQL, no dashboard
* Shop staff: login id built from their phone, password set by the owner and sent
  on WhatsApp; the owner can reset it the same way
* Owner, manager and head office: email and password, a six digit code by email
  instead of a password, forgot-password by email, and an emailed link to choose
  their own first password when the owner leaves the password blank
  (`docs/EMAIL.md`)
* Nobody is ever deleted, only switched off

## Next, in the order I would do it

**1. WhatsApp Cloud API.** Today the app opens WhatsApp with the message filled in
and the sender presses send. Direct sending needs utility-category templates, which
are pre-approved fixed sentences with slots — an itemised vendor order does not fit
one, so this would make the message worse before it makes it easier. Worth doing when
the volume justifies designing around the template limits. Roughly ₹0.115 per message
for Indian numbers plus GST.

**2. OTP for shop staff.** They have no email, so the code has to go over WhatsApp or
SMS. That means the Cloud API above, or an SMS provider. Until then they use a password
the owner gives them.

**3. Reports.** Rate history per product, consumption per shop, fill rate, margin per
product and per shop, ageing. All of it is a query over data the app already stores.
Email delivery of the daily ones would go through the same SMTP sender as the login
emails.

**4. Multi-client.** Every record already carries a client id and the policies enforce
it. Still to make configurable per client: commission %, bill prefix, cutoff time,
billing cycle, credit period, whether they use a PO number, and whether non-indented
additions are allowed.

**5. Public site.** Company and operations before login, the client's own data after.
Five pages. Mobile-first, installable as a PWA.

## Before this carries real work

* SMTP — Supabase's built-in sender is rate limited and meant for testing, so the
  code and reset emails will be dropped under daily use. `docs/EMAIL.md` has the
  Resend setup.
* The Magic Link email template must contain `{{ .Token }}`, or the six digit code
  never appears in the email.
* Redeploy the `create-user` function after any change to it — the dashboard editor
  does not pick up what is in this repository on its own.

## Open questions for the owner

* Bill number format
* An auto-confirm window if a shop never acknowledges a delivery
* Selling margins: he is sending an Excel with one tab per shop
* Fruit vendor groups — 109 products currently fall into Manual order
* Credit period per client
