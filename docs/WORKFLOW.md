# The business rules this code implements

Every rule below came from the owner. Where the code makes a choice he has not yet
made, it is marked **provisional**.

## The day

| Time | What happens |
|---|---|
| evening | A shop sends its indent whenever it is ready. Nothing is pre-filled — a shop that does not order simply has no indent |
| night | Admin cuts the indent and accepts it, then sends one order per vendor group over WhatsApp |
| next morning | Vendor bills arrive together. Rates entered first, then packed quantities shop by shop |
| | Out for delivery → shop manager confirms weights → invoice generated |

**The indent window is switched off.** It was 6–9 pm, with anything up to 11:30 pm
recorded as `late`. `WINDOW_ON` in `src/template.html` turns the rule back on, and
nothing else has to change: the hours, the late flag, the notes on the shop's screen
and the owner's override are all still there and still work. While it is off, no
indent is refused for being early or late and nothing is flagged.

Shop managers over-order, so cutting lines is a normal part of acceptance, not an
exception. The owner is himself part of the client chain and knows the real quantities.

## Indent states

| State | Who may change it |
|---|---|
| `draft` | Shop, freely |
| `submitted` | Shop **owner** only — still editable until Velora accepts |
| `accepted` | Velora admin only. Quantities cut, products removed |
| packed / shipped / received / billed | Nobody edits the indent |

Head office may also enter and edit indents on a shop's behalf.

## Ordering

* A product belongs to exactly one **group**; a group belongs to one **vendor**.
  There is no backup vendor.
* The group → vendor link is a preset, but each day's order must still be
  **confirmed** before it goes out.
* Orders are **already split shop-wise**. Velora does not buy in bulk and divide it —
  the vendor packs into shop lots at Koyambedu.
* Groups flagged `manual` (currently **Others** and **Manual order**) are placed by
  hand and only marked as ordered in the app.
* Any product not listed in a group tab falls into **Manual order** automatically.

## Rates and quantities

1. All vendor bills arrive at once, so the rate screen is **clubbed by vendor group** —
   one block per bill.
2. Market rate is entered once per product per day and is the **same for every shop**.
3. Packed quantity is then entered shop by shop against that shop's indent. It may be
   more or less than indented.
4. A vendor may skip a product entirely on quality. Enter `0`.
   **A skipped product does not appear on the invoice**, even though it was indented.
5. Products nobody indented may be bought anyway — cheap price, good quality — and are
   added on the packing screen. No notification is sent; the shop that received it is
   simply billed for it.

Vendor bill totals are **not** entered into the system. They are verified by hand.

## Delivery

Packing → **out for delivery** → WhatsApp to the shop manager with the items, weights
and prices → the manager checks against the crates and confirms. If something differs
he tells Velora, it is agreed, the quantity is reduced, and **only then** is the
invoice generated.

## Billing and accounts

* One bill per shop per **delivery day**. These daily invoices are the record.
* A **weekly summary** (Monday to Sunday) drives payment, which is due on Monday.
* The client owner pays **one amount for all his shops**. Payments are recorded at
  chain level, not per shop.
* **Partial payments are accepted** and applied to the **oldest bill first**.
* Only the Velora owner records payments. The client owner sees the same ledger —
  amount, mode, reference, balance — and can change nothing.

Settlement is recomputed from bill order and total received every time it is
displayed. No allocation is stored, so it cannot drift out of sync, and correcting a
mistyped payment re-settles everything correctly.

## Not yet decided

* Bill number format — `VF/<SHOP>/<MMYYYY>/<0001>` is **provisional**
* What happens if a shop never confirms receipt (the invoice currently waits forever;
  an auto-confirm window is recommended)
* Where a reduced delivery quantity is recorded as a shortfall — goods were bought and
  paid for, so the difference should land somewhere or margin reporting will not
  reconcile
* Credit period, and whether extra non-indented products need client consent under
  other clients' contracts
