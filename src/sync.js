/* ============================================================
   Velora Fresh — Supabase sync
   Inlined into index.html by src/build.py.

   Local-first. Every read and write still goes through the same
   localStorage blob the app has always used, so the admin entering
   rates at Koyambedu at 4 am on bad signal never waits for a network
   round trip. Changes are diffed into row operations, queued, and
   pushed when the connection allows.

   Talks to PostgREST with fetch rather than loading supabase-js from a
   CDN: the app stays one file and works with no network at all.
   ============================================================ */

const VFSync = (function () {
  'use strict';

  const QKEY  = 'VF_QUEUE';      // pending row operations
  const SKEY  = 'VF_SYNCED';     // last snapshot known to be on the server
  const AKEY  = 'VF_AUTH';       // session tokens

  /* ---------- configuration ----------
     Filled in by the deployer. With no url the app runs exactly as it
     did before: pure localStorage, no network, nothing to break. */
  const CFG = window.VF_CONFIG || { url: '', anonKey: '', clientId: 'KPN' };

  const enabled = () => !!(CFG.url && CFG.anonKey);

  /* ============================================================
     1. Flatten the nested blob into rows
     ============================================================
     The app stores one nested object keyed by date. The database is
     normalised. Rather than diff the nesting, both sides are flattened
     to `table -> key -> row` and compared as flat maps. Diffing then
     falls out as a set comparison, and a change to one product's rate
     produces exactly one row operation.                              */

  function flatten(DB) {
    const out = {
      indents: {}, indent_lines: {}, day_rates: {}, packed: {},
      shipments: {}, vendor_orders: {}, invoices: {}, invoice_lines: {},
      payments: {}, vendors: {}, vendor_bank: {}, margin_comm: {},
      margin_selling: {}, settings: {},
    };
    if (!DB) return out;

    // ---- indents ----
    Object.keys(DB.indents || {}).forEach(date => {
      Object.keys(DB.indents[date] || {}).forEach(shop => {
        const ind = DB.indents[date][shop] || {};
        // an untouched draft with no lines is not worth a row
        const lines = ind.lines || {};
        if (ind.status === 'draft' && !Object.keys(lines).length) return;

        out.indents[date + '|' + shop] = {
          trade_date: date, shop_id: shop,
          status: ind.status || 'draft',
          submitted_at: ind.submittedAt || null,
          late: !!ind.late,
        };
        Object.keys(lines).forEach(code => {
          out.indent_lines[date + '|' + shop + '|' + code] = {
            trade_date: date, shop_id: shop,
            product_code: code, qty: Number(lines[code]) || 0,
          };
        });
      });
    });

    // ---- the trading day ----
    Object.keys(DB.days || {}).forEach(date => {
      const day = DB.days[date] || {};

      Object.keys(day.rates || {}).forEach(code => {
        const r = day.rates[code];
        if (r === '' || r === null || r === undefined) return;
        out.day_rates[date + '|' + code] = {
          trade_date: date, product_code: code, rate: Number(r) || 0,
        };
      });

      Object.keys(day.packed || {}).forEach(shop => {
        const p = day.packed[shop] || {};
        Object.keys(p).forEach(code => {
          // 0 is meaningful — the vendor skipped it on quality — so it
          // is stored, not dropped
          out.packed[date + '|' + shop + '|' + code] = {
            trade_date: date, shop_id: shop,
            product_code: code, qty: Number(p[code]) || 0,
          };
        });
      });

      Object.keys(day.ship || {}).forEach(shop => {
        const st = day.ship[shop];
        if (!st) return;
        out.shipments[date + '|' + shop] = {
          trade_date: date, shop_id: shop,
          state: st === 'received' ? 'received' : 'out',
        };
      });

      Object.keys(day.sent || {}).forEach(g => {
        if (!day.sent[g]) return;
        out.vendor_orders[date + '|' + g] = { trade_date: date, group_name: g };
      });
    });

    // ---- invoices ----
    Object.keys(DB.invoices || {}).forEach(date => {
      Object.keys(DB.invoices[date] || {}).forEach(shop => {
        const inv = DB.invoices[date][shop];
        if (!inv) return;
        const id = inv.id || uuidFor(date + '|' + shop);
        out.invoices[date + '|' + shop] = {
          id: id, bill_no: inv.no, trade_date: date, shop_id: shop,
          total: round2(inv.total), round_off: round2(inv.roundOff || 0),
          net_amount: round2((inv.total || 0) + (inv.roundOff || 0)),
        };
        (inv.lines || []).forEach((l, i) => {
          out.invoice_lines[date + '|' + shop + '|' + (i + 1)] = {
            invoice_id: id, line_no: i + 1,
            product_code: l.code, name: l.name, tamil: l.tamil || '',
            unit: l.unit, qty: Number(l.qty) || 0, net_kg: Number(l.net) || 0,
            // frozen values — never recomputed from the current master
            rate: Number(l.rate) || 0,
            amount: round2(l.amount),
            sell: Number(l.sell) || 0,
          };
        });
      });
    });

    // ---- money ----
    (DB.payments || []).forEach(p => {
      if (!p || !p.id) return;
      out.payments[p.id] = {
        id: uuidFor(p.id), client_id: CFG.clientId,
        paid_on: p.date, amount: round2(p.amount),
        mode: p.mode || 'NEFT', ref: p.ref || '',
      };
    });

    // ---- vendors ----
    Object.keys(DB.vendors || {}).forEach(g => {
      const v = DB.vendors[g] || {};
      out.vendors[g] = {
        group_name: g, name: v.name || '', phone: v.phone || '',
        contact: v.contact || '', address: v.address || '', notes: v.notes || '',
      };
      const b = v.bank || {};
      // only send a bank row once something has been entered; an empty
      // one would be refused for any role but owner
      if (b.acName || b.acNo || b.ifsc || b.upi) {
        out.vendor_bank[g] = {
          group_name: g, ac_name: b.acName || '', ac_no: b.acNo || '',
          ifsc: b.ifsc || '', upi: b.upi || '',
        };
      }
    });

    // ---- margins ----
    const m = DB.master || {};
    Object.keys(m.comm || {}).forEach(shop => {
      out.margin_comm[shop] = { shop_id: shop, pct: Number(m.comm[shop]) || 0 };
    });
    Object.keys(m.selling || {}).forEach(shop => {
      Object.keys(m.selling[shop] || {}).forEach(code => {
        out.margin_selling[shop + '|' + code] = {
          shop_id: shop, product_code: code,
          pct: Number(m.selling[shop][code]) || 0,
        };
      });
    });

    // ---- settings ----
    out.settings[CFG.clientId] = {
      client_id: CFG.clientId, anytime: !!(DB.settings || {}).anytime,
    };

    return out;
  }

  function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

  /* Stable uuid from a string, so the same logical record keeps the same
     id on every device without a server round trip. Not a real v5 hash —
     it only has to be deterministic and collision-free over our keys. */
  function uuidFor(str) {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str)) return str;
    let h1 = 0x811c9dc5, h2 = 0x01000193, h3 = 0x9e3779b9, h4 = 0x85ebca6b;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
      h2 = Math.imul(h2 + c, 2654435761) >>> 0;
      h3 = Math.imul(h3 ^ (c + i), 2246822519) >>> 0;
      h4 = Math.imul(h4 + (c * (i + 1)), 3266489917) >>> 0;
    }
    const hex = n => ('00000000' + n.toString(16)).slice(-8);
    const s = hex(h1) + hex(h2) + hex(h3) + hex(h4);
    return s.slice(0, 8) + '-' + s.slice(8, 12) + '-5' + s.slice(13, 16) + '-a'
         + s.slice(17, 20) + '-' + s.slice(20, 32);
  }

  /* ============================================================
     2. Diff two flat maps into row operations
     ============================================================ */

  // Natural keys, so a row can be upserted or deleted without knowing
  // the surrogate id the database assigned.
  const CONFLICT = {
    indents:        'trade_date,shop_id',
    indent_lines:   'trade_date,shop_id,product_code',
    day_rates:      'trade_date,product_code',
    packed:         'trade_date,shop_id,product_code',
    shipments:      'trade_date,shop_id',
    vendor_orders:  'trade_date,group_name',
    invoices:       'trade_date,shop_id',
    invoice_lines:  'invoice_id,line_no',
    payments:       'id',
    vendors:        'group_name',
    vendor_bank:    'group_name',
    margin_comm:    'shop_id',
    margin_selling: 'shop_id,product_code',
    settings:       'client_id',
  };

  function diff(before, after) {
    const ops = [];
    Object.keys(CONFLICT).forEach(table => {
      const a = before[table] || {}, b = after[table] || {};
      Object.keys(b).forEach(k => {
        if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
          ops.push({ table: table, op: 'upsert', key: k, row: b[k] });
        }
      });
      Object.keys(a).forEach(k => {
        if (!(k in b)) ops.push({ table: table, op: 'delete', key: k, row: a[k] });
      });
    });
    return ops;
  }

  /* Later operations on the same row supersede earlier ones. Without
     this, typing a rate four times would send four requests. */
  function collapse(ops) {
    const seen = {};
    ops.forEach(o => { seen[o.table + '\u0000' + o.key] = o; });
    // preserve insertion order of the surviving ops
    const out = [], done = {};
    ops.forEach(o => {
      const k = o.table + '\u0000' + o.key;
      if (done[k]) return;
      done[k] = true;
      out.push(seen[k]);
    });
    return out;
  }

  /* Parents before children, so a line never arrives before its header.
     Deletes run in reverse for the same reason. */
  const ORDER = ['settings', 'vendors', 'vendor_bank', 'margin_comm', 'margin_selling',
                 'indents', 'indent_lines', 'day_rates', 'packed', 'shipments',
                 'vendor_orders', 'invoices', 'invoice_lines', 'payments'];

  function sortOps(ops) {
    return ops.slice().sort((x, y) => {
      if (x.op !== y.op) return x.op === 'upsert' ? -1 : 1;
      const ix = ORDER.indexOf(x.table), iy = ORDER.indexOf(y.table);
      return x.op === 'upsert' ? ix - iy : iy - ix;
    });
  }

  /* ============================================================
     3. Queue — survives reload and offline
     ============================================================ */

  function readJSON(k, dflt) {
    try { return JSON.parse(localStorage.getItem(k)) || dflt; } catch (e) { return dflt; }
  }
  function writeJSON(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* full or private mode */ }
  }

  let queue = readJSON(QKEY, []);
  let synced = readJSON(SKEY, null);

  function record(DB) {
    if (!enabled()) return 0;
    const now = flatten(DB);
    const ops = diff(synced || {}, now);
    if (!ops.length) return 0;
    queue = collapse(queue.concat(ops));
    writeJSON(QKEY, queue);
    synced = now;          // optimistic: rolled back if the push fails
    writeJSON(SKEY, synced);
    schedule();
    return ops.length;
  }

  /* ============================================================
     4. Auth
     ============================================================ */

  let auth = readJSON(AKEY, null);

  function headers(extra) {
    const h = Object.assign({
      'apikey': CFG.anonKey,
      'Content-Type': 'application/json',
    }, extra || {});
    if (auth && auth.access_token) h['Authorization'] = 'Bearer ' + auth.access_token;
    return h;
  }

  async function signIn(email, password) {
    const r = await fetch(CFG.url + '/auth/v1/token?grant_type=password', {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ email: email, password: password }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error_description || j.msg || 'Sign in failed');
    auth = j; writeJSON(AKEY, auth);
    return j;
  }

  async function refresh() {
    if (!auth || !auth.refresh_token) return false;
    const r = await fetch(CFG.url + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ refresh_token: auth.refresh_token }),
    });
    if (!r.ok) { auth = null; writeJSON(AKEY, null); return false; }
    auth = await r.json(); writeJSON(AKEY, auth);
    return true;
  }

  function signOut() {
    auth = null; writeJSON(AKEY, null);
  }

  const signedIn = () => !!(auth && auth.access_token);

  /* ============================================================
     5. Push
     ============================================================ */

  let pushing = false, timer = null;
  const listeners = [];

  function on(fn) { listeners.push(fn); }
  function emit(state, detail) { listeners.forEach(f => { try { f(state, detail); } catch (e) {} }); }

  function schedule(ms) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(push, ms === undefined ? 800 : ms);
  }

  async function send(table, rows, isDelete, keyCols) {
    if (isDelete) {
      // one request per row: the filter is a conjunction of its key columns
      for (const row of rows) {
        const qs = keyCols.map(c => c + '=eq.' + encodeURIComponent(row[c])).join('&');
        const r = await fetch(CFG.url + '/rest/v1/' + table + '?' + qs, {
          method: 'DELETE', headers: headers(),
        });
        if (!r.ok && r.status !== 404) throw await httpError(r);
      }
      return;
    }
    const r = await fetch(
      CFG.url + '/rest/v1/' + table + '?on_conflict=' + encodeURIComponent(keyCols.join(',')),
      {
        method: 'POST',
        headers: headers({ 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify(rows),
      });
    if (!r.ok) throw await httpError(r);
  }

  async function httpError(r) {
    let body = '';
    try { body = JSON.stringify(await r.json()); } catch (e) { body = r.statusText; }
    const e = new Error('HTTP ' + r.status + ' ' + body);
    e.status = r.status;
    return e;
  }

  async function push() {
    if (!enabled() || pushing || !queue.length) return;
    if (!navigator.onLine) { emit('offline', queue.length); return; }
    if (!signedIn()) { emit('signed-out', queue.length); return; }

    pushing = true;
    emit('pushing', queue.length);
    const batch = sortOps(queue);

    try {
      // group consecutive ops of the same table and direction
      let i = 0;
      while (i < batch.length) {
        const t = batch[i].table, isDel = batch[i].op === 'delete';
        const rows = [];
        while (i < batch.length && batch[i].table === t && (batch[i].op === 'delete') === isDel) {
          rows.push(batch[i].row); i++;
        }
        await send(t, rows, isDel, CONFLICT[t].split(','));
      }
      queue = []; writeJSON(QKEY, queue);
      emit('synced', 0);
    } catch (err) {
      if (err.status === 401 && await refresh()) { pushing = false; return push(); }
      // keep the queue; the next attempt retries it
      emit('error', err.message);
      schedule(15000);
    } finally {
      pushing = false;
    }
  }

  /* ============================================================
     6. Pull
     ============================================================
     Rebuilds the nested blob from the server. Used on first sign-in and
     when a device has been away. Anything still queued locally is
     pushed afterwards, so unsent local work is never lost. */

  async function get(table, select) {
    const r = await fetch(CFG.url + '/rest/v1/' + table + '?select=' + (select || '*'),
                          { headers: headers() });
    if (!r.ok) throw await httpError(r);
    return r.json();
  }

  async function pull(DB) {
    if (!enabled() || !signedIn()) return DB;

    const [inds, ilines, rates, pk, ship, vo, invs, ivl, pays, vend, vbank, mc, ms, st] =
      await Promise.all(['indents', 'indent_lines', 'day_rates', 'packed', 'shipments',
                         'vendor_orders', 'invoices', 'invoice_lines', 'payments',
                         'vendors', 'vendor_bank', 'margin_comm', 'margin_selling',
                         'settings'].map(t => get(t).catch(() => [])));

    const indById = {};
    inds.forEach(i => {
      indById[i.id] = i;
      const d = DB.indents[i.trade_date] = DB.indents[i.trade_date] || {};
      d[i.shop_id] = { status: i.status, lines: {},
                       submittedAt: i.submitted_at, late: !!i.late };
    });
    ilines.forEach(l => {
      const hdr = indById[l.indent_id];
      if (!hdr) return;
      const rec = (DB.indents[hdr.trade_date] || {})[hdr.shop_id];
      if (rec) rec.lines[l.product_code] = Number(l.qty);
    });

    const day = d => (DB.days[d] = DB.days[d] ||
                      { rates: {}, packed: {}, ship: {}, sent: {} });
    rates.forEach(r => { day(r.trade_date).rates[r.product_code] = Number(r.rate); });
    pk.forEach(p => {
      const D = day(p.trade_date);
      (D.packed[p.shop_id] = D.packed[p.shop_id] || {})[p.product_code] = Number(p.qty);
    });
    ship.forEach(s => { day(s.trade_date).ship[s.shop_id] = s.state; });
    vo.forEach(o => { day(o.trade_date).sent[o.group_name] = true; });

    const invById = {};
    invs.forEach(v => {
      invById[v.id] = v;
      const d = DB.invoices[v.trade_date] = DB.invoices[v.trade_date] || {};
      d[v.shop_id] = { id: v.id, no: v.bill_no, date: v.trade_date, shopId: v.shop_id,
                       total: Number(v.total), roundOff: Number(v.round_off), lines: [] };
    });
    ivl.sort((a, b) => a.line_no - b.line_no).forEach(l => {
      const h = invById[l.invoice_id];
      if (!h) return;
      const rec = (DB.invoices[h.trade_date] || {})[h.shop_id];
      if (!rec) return;
      rec.lines.push({ code: l.product_code, name: l.name, tamil: l.tamil, unit: l.unit,
                       qty: Number(l.qty), net: Number(l.net_kg), rate: Number(l.rate),
                       amount: Number(l.amount), sell: Number(l.sell) });
    });

    DB.payments = pays.map(p => ({ id: p.id, date: p.paid_on, amount: Number(p.amount),
                                   mode: p.mode, ref: p.ref }));

    vend.forEach(v => {
      const rec = DB.vendors[v.group_name] = DB.vendors[v.group_name] ||
        { bank: { acName: '', acNo: '', ifsc: '', upi: '' } };
      rec.name = v.name; rec.phone = v.phone; rec.contact = v.contact;
      rec.address = v.address; rec.notes = v.notes;
    });
    // empty for every role but owner — RLS returns no rows rather than an error
    vbank.forEach(b => {
      const rec = DB.vendors[b.group_name];
      if (rec) rec.bank = { acName: b.ac_name, acNo: b.ac_no, ifsc: b.ifsc, upi: b.upi };
    });

    mc.forEach(m => { DB.master.comm[m.shop_id] = Number(m.pct); });
    ms.forEach(m => {
      (DB.master.selling[m.shop_id] = DB.master.selling[m.shop_id] || {})[m.product_code] =
        Number(m.pct);
    });
    if (st.length) DB.settings.anytime = !!st[0].anytime;

    // the server is now the baseline; anything still queued is local work
    synced = flatten(DB);
    writeJSON(SKEY, synced);
    return DB;
  }

  /* ============================================================
     7. Bill numbers — issued by the database, never locally
     ============================================================ */

  async function nextBillNo(shopId, date) {
    if (!enabled() || !signedIn()) return null;
    const r = await fetch(CFG.url + '/rest/v1/rpc/next_bill_no', {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ p_shop: shopId, p_date: date }),
    });
    if (!r.ok) throw await httpError(r);
    return r.json();
  }

  /* ---------- retry when the connection comes back ---------- */
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('online', () => schedule(300));
  }

  return {
    enabled, signIn, signOut, signedIn, refresh, pull, push, record,
    nextBillNo, on, queueLength: () => queue.length,
    // exported for the tests
    _flatten: flatten, _diff: diff, _collapse: collapse, _sortOps: sortOps,
    _uuidFor: uuidFor, _reset: function () { queue = []; synced = null; },
  };
})();

/* Inlined into the app's single script block, so `const` alone would keep
   this out of reach of the tests and the console. */
if (typeof window !== 'undefined') window.VFSync = VFSync;
