# Velora Fresh — supply desk

Working prototype for **Velora Innovations Private Limited**, trading as **Velora Fresh**:
fruit and vegetable supply to supermarket chains in Tamil Nadu.

It covers one full trading cycle — a shop's indent in the evening, the vendor orders
that night, market rates and packed quantities the next morning, delivery confirmation,
the invoice, and weekly accounts.

Current state: **single-file front end, all data in `localStorage`.** No server yet.
Everything is real and calculating correctly; the storage layer is the only stub.

---

## Run it

```bash
git clone <your repo>
cd velora-fresh
python3 -m http.server 8080     # or just open index.html
```

Open <http://localhost:8080>. Switch roles from the dropdown in the header.

There is no indent window: a shop can send its indent at any hour. The 6 pm–9 pm
rule is still in the code behind `WINDOW_ON` in `src/template.html` if it is ever
wanted back.

## Build

`index.html` is **generated**. Do not edit it directly.

```bash
python3 src/build.py            # src/template.html + data/*.txt -> index.html
node test/smoke.js              # 25 checks across the whole cycle
```

When the product or group spreadsheet changes:

```bash
pip install openpyxl
python3 src/import_sheets.py data/Vendor_Group.xlsx   # rewrites data/*.txt
python3 src/build.py
node test/smoke.js
```

---

## Repository layout

```
index.html                generated app — do not edit
src/template.html         the source, with @@PRODUCTS@@ and @@GROUPS@@ placeholders
src/build.py              substitutes the data files into the template
src/import_sheets.py      regenerates data/*.txt from the spreadsheets
data/products.txt         code|English / Tamil|unit|unit weight kg|selling margin %|alias
data/groups.txt           group name|code,code,code
data/Vendor_Group.xlsx    source spreadsheet for both of the above
test/smoke.js             headless run of the whole day cycle (jsdom)
docs/WORKFLOW.md          the business rules the code implements
docs/DATA_MODEL.md        what is stored and where
docs/ROADMAP.md           what is built, what is next
```

---

## Roles

| Role | Sees |
|---|---|
| **Owner** (Velora) | Everything. Only role that can record payments, edit margins, or view vendor bank details |
| **Admin** (Velora) | Day board, indents, orders, rates, packing, delivery, invoices, vendors. No margins, no payments, no bank details |
| **Head office** (client) | Indents (can edit), invoices, accounts — all read-only on money. No selling price, no cost |
| **Shop** | Its own indent, its own deliveries, its own bills and outstanding balance |

Logins are a role dropdown for now. Real auth arrives with the backend — see
`docs/ROADMAP.md`.

## Pricing

Three layers, and only the first is shared across shops:

```
market rate            typed each morning from the vendor's bill, same for all shops
  x (1 + commission%)  per shop, set in the margin master  ->  PURCHASE PRICE (billed)
  x (1 + selling%)     per shop per product                ->  SELLING PRICE (shelf)
```

Worked through: market ₹100, commission 4% → billed ₹104/kg. At a 30% selling
margin the shop's shelf price shows ₹135.20.

The commission lives **inside** the per-kg rate. There is no separate service charge
line on the invoice. The business is GST exempt, so no tax appears anywhere.

An invoice **snapshots** the rate and amount when it is generated. Changing a margin
afterwards never re-prices a bill that has already been raised.

---

## Known gaps

* 7 box/tray products have no unit weight on file (86, 396, 280, 293, 60, 330, 329).
  Invoice generation is deliberately blocked rather than billing them at zero.
* 109 products are in no vendor group and fall into **Manual order**. Mostly fruit —
  add the fruit tabs to `Vendor_Group.xlsx` and re-import, or make the groups from
  **Product → Product list**, beside the Vendor group box on the add form: **+ New
  group** makes one without leaving the product being typed, **Rename** changes an
  existing one. A rename moves the products, the vendor, its bank details and every
  order already placed under the old name, in one transaction (`rename_group` in
  `supabase/02_security.sql`). `Manual order` is not a vendor and keeps its name.
* Every row of the product list has an **Edit** button (Velora only). It changes the
  name, the Tamil name, the unit, the box weight and the vendor group of a product
  already on the list, and it is where a product is removed from the catalogue.
  A product a trading day still points at cannot be removed — an indent, a market
  rate, a packing line or a vendor order referencing a product that is no longer
  there could not be priced or billed, so the app names the day and refuses. Bills
  already raised are never affected: an invoice line keeps its own copy of the name,
  unit and rate.
* WhatsApp and email sending are stubs that show the message that would go out.
* Bill number format `VF/<SHOP>/<MMYYYY>/<0001>` is provisional.
