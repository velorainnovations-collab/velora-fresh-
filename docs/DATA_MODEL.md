# Data model

Everything currently lives in one `localStorage` key, `VF_DB`. The shapes below are
what the backend should mirror.

```js
DB = {
  indents: {
    "2026-07-30": {
      "KLP": { status, lines: { "<code>": qty }, submittedAt, late }
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
