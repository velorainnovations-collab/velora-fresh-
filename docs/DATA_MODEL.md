# Data model

Everything currently lives in one `localStorage` key, `VF_DB`. The shapes below are
what the backend should mirror.

```js
DB = {
  indents: {
    "2026-07-30": {
      "KLP": { status, lines: { "<code>": qty },
               seq: { "<code>": 3 },        // the order it was written in
               submittedAt, late }
    }
  },

  days: {
    "2026-07-30": {
      rates:  { "<code>": marketRatePerKg },   // same for every shop
      packed: { "KLP": { "<code>": qty } },    // 0 = vendor skipped it
      ship:   { "KLP": "out" | "received" },
      sent:   { "<group>": true }              // vendor order placed
    }
  },

  invoices: {
    "2026-07-30": {
      "KLP": { no, saved,                       // no number until saved
               date, shopId, total, roundOff,
               contactId,                        // who it is made out to
               vehicle, driver, place,           // what it went out on, and where to
               billTo: { name, gstin, address, state, pincode },  // snapshot, see below
               lines: [ {
        code, name, tamil, unit, qty, net, rate, amount, sell
      } ] }
    }
  },

  contacts: {
    "<uuid>": { company, person, gstin, mobile, email,
                shopId,                          // whose bills it is offered for
                addr1, addr2, addr3, state, pincode,   // billing = delivery
                active,
                bank: { bankName, acName, acNo, ifsc, branch } }  // owner-only
  },

  payments: [ { id, date, amount, mode, ref } ],   // chain level, oldest bill first

  vendors: {
    "<group>": { name, phone, contact, address, notes, manual,
                 bank: { acName, acNo, ifsc, upi } }   // bank is owner-only
  },

  master: {
    comm:    { "KLP": 4 },                       // commission %, per shop
    selling: { "KLP": { "<code>": 30 } }          // selling margin %, per shop per product
  },

  serial:   { "KLP-072026": 7 },                  // bill serial, per shop per month
  settings: { anytime: false }                    // ignore the indent window
}
```

## Nothing is listed alphabetically

An indent is not a catalogue. It is the list somebody built, and the thing they
just put on it is the thing they are still thinking about — so every screen reads
newest first. Not by name, and not by product code, which is what a plain object
hands back for free because a key that looks like a number sorts like one.

`indents[date][shop].seq` carries the position each line was written at; bigger is
newer. Changing a quantity does not renumber, so everything below a new line keeps
the order it had.

The day's screens — market rates, the vendor order, packing, the delivery note and
the bill — read from the same rule. A day is written by several shops at once on
separate phones, so there is no one counter to lean on; what there is, is how far
down its own list each shop wrote the product, and a thing written late by anybody
is a thing added late. Anything first seen at packing was put on the day after
every indent had closed, so it ranks above all of them.

The catalogue follows it too: `products.added_ord`, newest first. The 241 that came
with the build have no such moment on record, so they keep the order the catalogue
file was written in, underneath everything added since.

Code only ever breaks a tie, so that two things added at the same moment come out
in the same order every time.

## Invoice lines are frozen

`invoices[date][shop].lines[]` stores `rate`, `amount` and `sell` as values, not as
formulas over the current master. Changing a margin later cannot alter a bill that has
already been raised. Keep this property in any backend port.

## A draft is not a bill

`saved` is false until somebody presses Save invoice. Until then the invoice has no
number, is not sent to the server at all, and nothing counts it — not the day board,
not the accounts, not the shop's own list of bills. The number is issued by saving,
so a draft that is thought better of and discarded leaves no gap in the run.

Editing a saved bill puts it back to a draft, keeping its number. It disappears from
the server while it is being edited and returns when it is saved again. That is the
intended behaviour, not a side effect: a bill under revision is not a bill.

## So is who the bill was made out to

`invoices[date][shop].billTo` is a copy of the contact's company name, GST number and
address, taken when the invoice is raised and again whenever the customer on it is
re-picked. The invoice also keeps `contactId`, but only so the dropdown can show what
was chosen — nothing is printed from the live contact.

A customer that moves premises in October must not silently reprint July's bill with
the new address, for exactly the reason the lines are frozen. It is also what lets a
contact be edited, deactivated or deleted outright without touching a bill: the
`contact_id` foreign key is `on delete set null`.

There is one address, not two. The billing address is the delivery address, because
two addresses that have to agree are two chances to be wrong.

## Bill numbers

`serial` is incremented locally today. **On a server this must be issued inside a
transaction**, or two devices generating at once will collide.

## Derived, never stored

* Bill settlement (`cleared` / `part` / `open`) — recomputed from bill order and
  total received
* Fill rate — indented lines versus packed lines
* Whether a line was indented — a packed line with no matching indent row is an
  addition, by definition. No flag needed
