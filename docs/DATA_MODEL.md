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
      "KLP": { no, date, shopId, total, roundOff, lines: [ {
        code, name, tamil, unit, qty, net, rate, amount, sell
      } ] }
    }
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

## Bill numbers

`serial` is incremented locally today. **On a server this must be issued inside a
transaction**, or two devices generating at once will collide.

## Derived, never stored

* Bill settlement (`cleared` / `part` / `open`) — recomputed from bill order and
  total received
* Fill rate — indented lines versus packed lines
* Whether a line was indented — a packed line with no matching indent row is an
  addition, by definition. No flag needed
