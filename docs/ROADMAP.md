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

## Next, in the order I would do it

**1. Backend.** Firebase (Firestore + Auth + Hosting + one Cloud Function) on the
Blaze plan. Blaze is required regardless of volume because the free plan cannot make
outbound calls, which WhatsApp needs.

* Offline persistence — the admin enters rates at Koyambedu at 4 am on poor signal
* Security rules enforcing client isolation at the data layer, not in the interface
* Bill numbers issued by a Cloud Function inside a transaction

All storage in the app goes through `load()` and `save()`. Swapping the storage layer
should not touch the screens, the pricing maths or the invoice.

**2. Real logins.** Phone number plus 4-digit PIN, not email and passwords — the users
are shop staff on shared phones. Deactivate users, never delete: past indents must stay
attached to whoever entered them.

**3. WhatsApp Cloud API.** Utility-category templates for vendor orders, pack lists and
invoices. Roughly ₹0.115 per message for Indian numbers plus GST, so a few hundred
rupees a month at this scale. Templates need pre-approval, so design them as fixed
sentences with slots.

**4. Reports.** Rate history per product, consumption per shop, fill rate, margin per
product and per shop, ageing. All of it is a query over data the app already stores.

**5. Multi-client.** Every record carries a client id and the security rules enforce
it. Per client: commission %, bill prefix, cutoff time, billing cycle, credit period,
whether they use a PO number, and whether non-indented additions are allowed.

**6. Public site.** Company and operations before login, the client's own data after.
Five pages. Mobile-first, installable as a PWA.

## Open questions for the owner

* Bill number format
* An auto-confirm window if a shop never acknowledges a delivery
* Selling margins: he is sending an Excel with one tab per shop
* Fruit vendor groups — 109 products currently fall into Manual order
* Credit period per client
