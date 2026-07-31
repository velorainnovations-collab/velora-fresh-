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

  /* Creating the account. Safe to leave open: an account with no
     invite gets no app_users row, and every policy then resolves to
     false — it can sign in and see nothing at all. The invite, not the
     signup, is what grants access. */
  async function signUp(email, password) {
    const r = await fetch(CFG.url + '/auth/v1/signup', {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ email: email, password: password }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error_description || j.msg || j.message || 'Could not create the account');
    // a session comes back only when email confirmation is switched off
    if (j.access_token) { auth = j; writeJSON(AKEY, auth); return { signedIn: true }; }
    return { signedIn: false, needsConfirmation: true };
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
        if (!r.ok && r.status !== 404) throw await httpError(r, table);
      }
      return;
    }
    // Postgres refuses to let ON CONFLICT DO UPDATE touch the same row
    // twice in one statement — it raises cardinality_violation, which
    // PostgREST returns as 409. collapse() dedupes by operation key,
    // which is not always the same thing as the database conflict key,
    // so the payload is deduped again here on the columns that actually
    // decide the conflict. Later rows win, matching last-write-wins.
    const byKey = new Map();
    rows.forEach(row => byKey.set(keyCols.map(c => String(row[c])).join('\u0000'), row));
    const unique = Array.from(byKey.values());

    const r = await fetch(
      CFG.url + '/rest/v1/' + table + '?on_conflict=' + encodeURIComponent(keyCols.join(',')),
      {
        method: 'POST',
        headers: headers({ 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify(unique),
      });
    if (!r.ok) throw await httpError(r, table);
  }

  async function httpError(r, table) {
    let body = null;
    try { body = await r.json(); } catch (e) { /* empty or non-JSON */ }
    // PostgREST puts the real cause in message/details/hint; without it a
    // failure is just a number and cannot be diagnosed from a screenshot
    const detail = body
      ? [body.message, body.details, body.hint].filter(Boolean).join(' — ')
      : r.statusText;
    const e = new Error((table ? table + ': ' : '') + 'HTTP ' + r.status + ' ' + detail);
    e.status = r.status;
    e.table = table;
    e.body = body;
    if (typeof console !== 'undefined') console.error('[VFSync]', e.message, body || '');
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
    if (!r.ok) throw await httpError(r, table);
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
     7. Who is signed in
     ============================================================
     The role comes from the database, never from the browser. The
     read_self policy returns exactly one row — the caller's own — so
     nobody can ask for somebody else's tag. A signed-in account with
     no app_users row returns nothing, which is the intended default
     for an uninvited signup. */

  async function whoami() {
    if (!enabled() || !signedIn()) return null;
    const r = await fetch(
      CFG.url + '/rest/v1/app_users?select=id,full_name,role,client_id,shop_id,active',
      { headers: headers() });
    if (r.status === 401 && await refresh()) return whoami();
    if (!r.ok) throw await httpError(r, 'app_users');
    const rows = await r.json();
    const me = rows.filter(u => u.active)[0];
    if (!me) return null;
    // the app's own notion of a role: a shop user *is* their shop
    me.appRole = me.role === 'shop' ? me.shop_id : me.role;
    return me;
  }

  /* ============================================================
     8. People
     ============================================================
     Thin wrappers over the functions in supabase/06_users.sql. Every
     one of them re-checks is_owner() server side, so a browser that
     calls them without the right role is refused by the database
     rather than by the interface. */

  async function rpc(fn, args) {
    if (!enabled() || !signedIn()) throw new Error('Not signed in');
    const r = await fetch(CFG.url + '/rest/v1/rpc/' + fn, {
      method: 'POST', headers: headers(),
      body: JSON.stringify(args || {}),
    });
    if (r.status === 401 && await refresh()) return rpc(fn, args);
    if (!r.ok) throw await httpError(r, fn);
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  }

  const listPeople      = ()             => rpc('list_people');

  /* Create the login outright, password and all, instead of waiting for
     the person to sign up. Runs in an edge function because it needs the
     service_role key. Throws NOT_DEPLOYED if the function is not there,
     so the caller can fall back to an invite. */
  /* A new password for someone who forgot theirs. Same function, same
     owner check — shop staff have no email, so there is no reset link
     to send them and the owner hands the new one over instead. */
  async function resetPassword(userId, password) {
    if (!enabled() || !signedIn()) throw new Error('Not signed in');
    let r;
    try {
      r = await fetch(CFG.url + '/functions/v1/create-user', {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ action: 'reset', user_id: userId, password: password }),
      });
    } catch (e) {
      const err = new Error('NOT_DEPLOYED'); err.notDeployed = true; throw err;
    }
    if (r.status === 404) { const e = new Error('NOT_DEPLOYED'); e.notDeployed = true; throw e; }
    if (r.status === 401 && await refresh()) return resetPassword(userId, password);
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || ('Could not reset (' + r.status + ')'));
    return body;
  }

  async function createUser(o) {
    if (!enabled() || !signedIn()) throw new Error('Not signed in');
    let r;
    try {
      r = await fetch(CFG.url + '/functions/v1/create-user', {
        method: 'POST', headers: headers(),
        body: JSON.stringify({
          email: o.email, password: o.password, full_name: o.name || '',
          role: o.role, phone: o.phone || null,
          client_id: o.clientId || null, shop_id: o.shopId || null,
        }),
      });
    } catch (e) {
      const err = new Error('NOT_DEPLOYED'); err.notDeployed = true; throw err;
    }
    if (r.status === 404) { const e = new Error('NOT_DEPLOYED'); e.notDeployed = true; throw e; }
    if (r.status === 401 && await refresh()) return createUser(o);
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || ('Could not create the login (' + r.status + ')'));
    return body;
  }

  /* A new branch. Written straight through rather than queued: every
     indent, packed line and margin row carries a foreign key to shops,
     so the shop has to exist on the server before anything referencing
     it can be pushed. RLS lets only an owner do this. */
  async function addShop(shop) {
    if (!enabled() || !signedIn()) throw new Error('Not signed in');
    const r = await fetch(CFG.url + '/rest/v1/shops?on_conflict=id', {
      method: 'POST',
      headers: headers({ 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify([{ id: shop.id, client_id: CFG.clientId,
                              name: shop.name, prefix: shop.prefix }]),
    });
    if (r.status === 401 && await refresh()) return addShop(shop);
    if (!r.ok) throw await httpError(r, 'shops');
    return true;
  }
  const setPersonRole   = (id, role)     => rpc('set_person_role',   { p_user: id, p_role: role });
  const setPersonActive = (id, active)   => rpc('set_person_active', { p_user: id, p_active: active });
  const cancelInvite    = (id)           => rpc('cancel_invite',     { p_invite: id });
  const invitePerson    = (o) => rpc('invite_person', {
    p_role: o.role, p_full_name: o.name || '',
    p_phone: o.phone || null, p_email: o.email || null,
    p_client_id: o.clientId || null, p_shop_id: o.shopId || null,
  });

  /* ============================================================
     9. Catalogue
     ============================================================
     The 241 products are compiled into index.html, which is the right
     default: the app opens fully stocked with no network. But a product
     added later must outlive a reload and reach every device, so the
     database is the truth and the build is only the seed.             */

  async function addProduct(p) {
    if (!enabled() || !signedIn()) throw new Error('Not signed in');
    const r = await fetch(CFG.url + '/rest/v1/products?on_conflict=code', {
      method: 'POST',
      headers: headers({ 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify([{ code: p.code, name: p.name, tamil: p.tamil || '',
                              unit: p.unit, unit_weight_kg: p.wt || null,
                              alias: p.alias || '' }]),
    });
    if (r.status === 401 && await refresh()) return addProduct(p);
    if (!r.ok) throw await httpError(r, 'products');

    // the group mapping is a second row, and the product must exist first
    const g = await fetch(CFG.url + '/rest/v1/product_groups?on_conflict=product_code', {
      method: 'POST',
      headers: headers({ 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify([{ product_code: p.code, group_name: p.group }]),
    });
    if (!g.ok) throw await httpError(g, 'product_groups');
    return true;
  }

  /* A new vendor. The group row has to land before the vendor row —
     vendors.group_name references it — and before any product can be
     mapped to it. Queued writes would not hold that order, so both go
     straight through. */
  async function addVendorGroup(g) {
    if (!enabled() || !signedIn()) throw new Error('Not signed in');
    const grp = await fetch(CFG.url + '/rest/v1/vendor_groups?on_conflict=name', {
      method: 'POST',
      headers: headers({ 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify([{ name: g.name, manual: !!g.manual, sort_ord: g.sort || 50 }]),
    });
    if (grp.status === 401 && await refresh()) return addVendorGroup(g);
    if (!grp.ok) throw await httpError(grp, 'vendor_groups');

    const ven = await fetch(CFG.url + '/rest/v1/vendors?on_conflict=group_name', {
      method: 'POST',
      headers: headers({ 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify([{ group_name: g.name, name: g.vendorName || g.name,
                              phone: g.phone || '', contact: '', address: '', notes: '' }]),
    });
    if (!ven.ok) throw await httpError(ven, 'vendors');
    return true;
  }

  /* Everything the catalogue is made of, for merging over the build. */
  async function fetchCatalogue() {
    if (!enabled() || !signedIn()) return null;
    const [products, groups, mapping] = await Promise.all([
      get('products', 'code,name,tamil,unit,unit_weight_kg,alias').catch(() => []),
      get('vendor_groups', 'name,manual,sort_ord').catch(() => []),
      get('product_groups', 'product_code,group_name').catch(() => []),
    ]);
    return { products: products, groups: groups, mapping: mapping };
  }

  /* ============================================================
     10. Bill numbers — issued by the database, never locally
     ============================================================ */

  async function nextBillNo(shopId, date) {
    if (!enabled() || !signedIn()) return null;
    const r = await fetch(CFG.url + '/rest/v1/rpc/next_bill_no', {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ p_shop: shopId, p_date: date }),
    });
    if (!r.ok) throw await httpError(r, 'next_bill_no');
    return r.json();
  }

  /* ---------- retry when the connection comes back ---------- */
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('online', () => schedule(300));
  }

  return {
    enabled, signIn, signUp, signOut, signedIn, refresh, pull, push, record,
    whoami, nextBillNo, on, queueLength: () => queue.length,
    listPeople, invitePerson, createUser, resetPassword, setPersonRole, setPersonActive, cancelInvite,
    addShop, addProduct, addVendorGroup, fetchCatalogue,
    // exported for the tests
    _flatten: flatten, _diff: diff, _collapse: collapse, _sortOps: sortOps,
    _uuidFor: uuidFor, _reset: function () { queue = []; synced = null; },
  };
})();

/* Inlined into the app's single script block, so `const` alone would keep
   this out of reach of the tests and the console. */
if (typeof window !== 'undefined') window.VFSync = VFSync;
