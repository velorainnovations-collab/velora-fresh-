/* A stand-in for Supabase: the same auth and PostgREST shapes the app
   talks to, so the client code can be exercised end to end offline. */
const http = require('http');

const USERS = {
  'owner@velora.example':   { pw: 'right', uid: 'aaaa0000-0000-0000-0000-00000000000a',
                              row: { id: 'aaaa0000-0000-0000-0000-00000000000a', full_name: 'Velora Owner',
                                     role: 'owner', client_id: null, shop_id: null, active: true } },
  // Velora's other side: runs the day, but no margins, payments or bank
  // details — and no Master menu
  'admin@velora.example':   { pw: 'right', uid: 'bbbb0000-0000-0000-0000-00000000000b',
                              row: { id: 'bbbb0000-0000-0000-0000-00000000000b', full_name: 'Velora Manager',
                                     role: 'admin', client_id: null, shop_id: null, active: true } },
  // a shop login as the app makes one: id derived from the phone, and the
  // name on the row is the third thing they have to type
  'p9000000004@shop.velorafresh.in':
                            { pw: 'shoppass1', uid: 'dddd0000-0000-0000-0000-00000000000d',
                              row: { id: 'dddd0000-0000-0000-0000-00000000000d', full_name: 'Kilpauk Mgr',
                                     role: 'shop', client_id: 'KPN', shop_id: 'KLP', active: true } },
  // and one made under the older shape, which must still open
  'ngb.9000000005@shop.velorafresh.in':
                            { pw: 'oldshape1', uid: 'eeee0000-0000-0000-0000-00000000000e',
                              row: { id: 'eeee0000-0000-0000-0000-00000000000e', full_name: 'Nungambakkam Mgr',
                                     role: 'shop', client_id: 'KPN', shop_id: 'NGB', active: true } },
  'shop@velora.example':    { pw: 'right', uid: 'dddd0000-0000-0000-0000-00000000000d',
                              row: { id: 'dddd0000-0000-0000-0000-00000000000d', full_name: 'Kilpauk Mgr',
                                     role: 'shop', client_id: 'KPN', shop_id: 'KLP', active: true } },
  // signed up but never invited: authenticates, but has no app_users row
  'stranger@velora.example':{ pw: 'right', uid: 'ffff0000-0000-0000-0000-00000000000f', row: null },
};

/* one read of the schema, cached: create table plus the columns added
   to it later by name at the foot of the file */
let SCHEMA = null;
function schemaColumns() {
  if (SCHEMA) return SCHEMA;
  const sql = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'supabase', '01_schema.sql'), 'utf8');
  const out = {};
  const tbl = /create table (?:if not exists )?(\w+) \(([\s\S]*?)\n\);/g;
  let m;
  while ((m = tbl.exec(sql))) {
    out[m[1]] = m[2].split('\n').map(l => l.trim())
      .filter(l => l && !l.startsWith('--'))
      .map(l => l.split(/\s+/)[0].replace(/,$/, ''))
      .filter(c => ['primary', 'unique', 'constraint', 'check', 'foreign'].indexOf(c.toLowerCase()) < 0);
  }
  const alt = /alter table (\w+)\s+add column if not exists (\w+)/g;
  while ((m = alt.exec(sql))) (out[m[1]] = out[m[1]] || []).push(m[2]);
  SCHEMA = out;
  return out;
}

const received = [];         // every write the app sent
/* what the deployed project can do, so the tests can pretend it is
   older than the code in this repository */
const opts = { oldCreateUser: false, noWipeFn: false, noRenameFn: false,
               /* pretend the deployed database has never been migrated:
                  every column in this list answers PGRST204, the way
                  PostgREST does for a column it has never heard of */
               behindColumns: null };

/* Tokens are shaped like a real JWT — header.claims.signature — because
   the app reads its own user id out of the claims rather than asking. */
const tokenFor = uid =>
  'tok-' + uid + '.' + Buffer.from(JSON.stringify({ sub: uid })).toString('base64url') + '.sig';
const uidOf = req =>
  (req.headers.authorization || '').replace(/^Bearer\s+/, '').replace(/^tok-/, '').split('.')[0];

// products the "server" holds beyond the compiled catalogue
const EXTRA_PRODUCTS = [];
const EXTRA_MAPPING  = [];
const EXTRA_GROUPS   = [];   // vendor groups added at runtime
const RENAMED        = [];   // names rename_group has moved off, so the
                             // catalogue read stops offering them
const CONTACTS       = [];   // the contact master, so a bill can be
const CBANK          = [];   // made out to somebody after a reload
const LOCKED         = ['1'];// products a trading day elsewhere still
                             // points at, so the database refuses to
                             // delete them
const INDENTS        = [];   // indent headers, so their ids can be looked up
const ILINES         = [];   // and their lines, so a second device can read them
const PACKED         = [];   // what was packed, so the other device sees it
const ISSUES         = [];   // what the shop reported at the crates
const SHIPS          = [];   // and where the lorry is
const RATES          = {};   // trade_date|code -> market rate, for purchase_rate()
let LAST_CODE = '';          // the six digit code the mock last 'emailed'

// what list_people() returns; mutated by the rpc handlers below
const PEOPLE = [
  { kind: 'user', id: 'aaaa0000-0000-0000-0000-00000000000a', phone: null,
    full_name: 'Velora Owner', role: 'owner', client_id: null, shop_id: null, active: true },
  { kind: 'user', id: 'bbbb0000-0000-0000-0000-00000000000b', phone: '9000000002',
    full_name: 'Day Manager', role: 'admin', client_id: null, shop_id: null, active: true },
  { kind: 'user', id: 'dddd0000-0000-0000-0000-00000000000d', phone: '9000000004',
    full_name: 'Kilpauk Mgr', role: 'shop', client_id: 'KPN', shop_id: 'KLP', active: true },
  { kind: 'invite', id: 'inv-1', phone: '9111111111',
    full_name: 'Waiting Friend', role: 'admin', client_id: null, shop_id: null, active: false },
];

const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const send = (code, obj) => {
      /* Supabase answers at most 1000 rows per GET and truncates
         silently — 1000 rows and HTTP 200 look exactly like "that is
         all of them". The mock does the same, or a read that forgets
         to page passes every test here and loses rows on the real
         project. That is not theoretical: after a week of trading the
         indent lines passed 1000 and every device rebuilt the newest
         days as if their indents were empty. */
      if (req.method === 'GET' && Array.isArray(obj)) {
        const ord = url.searchParams.get('order');
        if (ord) {
          const cols = ord.split(',').map(c => c.split('.')[0]);
          obj = obj.slice().sort((a, b) => {
            for (const c of cols) {
              if (a[c] < b[c]) return -1;
              if (a[c] > b[c]) return 1;
            }
            return 0;
          });
        }
        const off = parseInt(url.searchParams.get('offset') || '0', 10) || 0;
        let lim = parseInt(url.searchParams.get('limit') || '', 10);
        if (isNaN(lim) || lim > 1000) lim = 1000;
        obj = obj.slice(off, off + lim);
      }
      res.writeHead(code, { 'Content-Type': 'application/json',
                            'Access-Control-Allow-Origin': '*',
                            'Access-Control-Allow-Headers': '*',
                            'Access-Control-Allow-Methods': '*' });
      res.end(JSON.stringify(obj === undefined ? null : obj));
    };
    if (req.method === 'OPTIONS') return send(200, {});

    if (url.pathname === '/functions/v1/create-user') {
      const a = JSON.parse(body || '{}');
      received.push({ table: 'fn:create-user', method: 'POST', rows: a });
      if (a.action === 'reset') {
        if (!a.user_id) return send(400, { error: 'Which user?' });
        if (!a.password || a.password.length < 8)
          return send(400, { error: 'Use a password of at least 8 characters' });
        const who = Object.keys(USERS).find(e => USERS[e].uid === a.user_id);
        if (who) USERS[who].pw = a.password;
        return send(200, { id: a.user_id, email: who || null, reset: true });
      }
      if (a.action === 'delete') {
        /* a deployment that predates the delete action does not know it,
           falls through to the create path and asks for an email */
        if (opts.oldCreateUser) return send(400, { error: 'An email address is required' });
        if (!a.user_id) return send(400, { error: 'Which user?' });
        if (a.user_id === 'aaaa0000-0000-0000-0000-00000000000a')
          return send(400, { error: 'You cannot delete your own login' });
        const i = PEOPLE.findIndex(p => p.id === a.user_id);
        if (i > -1) PEOPLE.splice(i, 1);
        const em = Object.keys(USERS).find(e => USERS[e].uid === a.user_id);
        if (em) delete USERS[em];
        return send(200, { id: a.user_id, deleted: true });
      }
      const byInvite = a.action === 'invite' || !a.password;
      if (!a.email) return send(400, { error: 'An email address is required' });
      if (!byInvite && a.password.length < 8)
        return send(400, { error: 'Use a password of at least 8 characters' });
      if (a.role === 'shop' && !a.shop_id) return send(400, { error: 'A shop login needs a shop' });
      /* the address is taken. A real person keeps it; an orphan — an
         auth account whose app_users row is gone, the leftover of an
         old delete that could only do half the job — is healed: removed
         and the create goes through, exactly as the edge function now
         does. */
      if (USERS[a.email]) {
        const holder = USERS[a.email];
        const hasRow = PEOPLE.some(x => x.id === holder.uid);
        if (hasRow) {
          return send(400, { error: 'A user with this email address has already been registered' });
        }
        delete USERS[a.email];
      }
      /* an active person already holds this phone */
      if (a.phone && PEOPLE.some(x => x.kind === 'user' && x.active && x.phone === a.phone)) {
        return send(400, { error: 'Account rolled back: duplicate key value violates unique '
          + 'constraint "app_users_phone_active_key"' });
      }
      const uid = 'made' + PEOPLE.length + '000-0000-0000-0000-00000000000c';
      PEOPLE.push({ kind: 'user', id: uid, phone: a.phone, full_name: a.full_name,
                    role: a.role, client_id: a.client_id, shop_id: a.shop_id, active: true });
      USERS[a.email] = { pw: byInvite ? null : a.password, uid: uid,
                         row: { id: uid, full_name: a.full_name, role: a.role,
                                client_id: a.client_id, shop_id: a.shop_id, active: true } };
      return send(200, { id: uid, email: a.email, role: a.role, invited: byInvite });
    }

    if (url.pathname === '/auth/v1/otp') {
      const { email } = JSON.parse(body || '{}');
      received.push({ table: 'auth:otp', method: 'POST', rows: { email } });
      if (!USERS[email]) return send(400, { msg: 'Signups not allowed for otp' });
      LAST_CODE = '654321';
      return send(200, {});
    }

    if (url.pathname === '/auth/v1/verify') {
      const { email, token } = JSON.parse(body || '{}');
      received.push({ table: 'auth:verify', method: 'POST', rows: { email, token } });
      if (token !== LAST_CODE) return send(400, { msg: 'Token has expired or is invalid' });
      const u = USERS[email];
      return send(200, { access_token: tokenFor(u.uid), refresh_token: 'r', token_type: 'bearer' });
    }

    if (url.pathname === '/auth/v1/recover') {
      const { email } = JSON.parse(body || '{}');
      received.push({ table: 'auth:recover', method: 'POST', rows: { email } });
      return send(200, {});     // same answer whether or not it exists
    }

    if (url.pathname === '/auth/v1/user' && req.method === 'PUT') {
      const { password } = JSON.parse(body || '{}');
      const tok = uidOf(req);
      const who = Object.keys(USERS).find(e => USERS[e].uid === tok);
      received.push({ table: 'auth:setpassword', method: 'PUT', rows: { password } });
      if (!who) return send(401, { msg: 'Not signed in' });
      USERS[who].pw = password;
      return send(200, { id: tok, email: who });
    }

    if (url.pathname === '/auth/v1/signup') {
      const { email, password } = JSON.parse(body || '{}');
      if (USERS[email]) return send(400, { msg: 'User already registered' });
      if (!password || password.length < 8) return send(400, { msg: 'Password too short' });
      const uid = 'new0' + Object.keys(USERS).length + '000-0000-0000-0000-00000000000e';
      // invited addresses get a row; anything else authenticates and sees nothing
      const invited = email === 'invited@velora.example';
      USERS[email] = { pw: password, uid: uid,
                       row: invited ? { id: uid, full_name: 'Invited Friend', role: 'admin',
                                        client_id: null, shop_id: null, active: true } : null };
      received.push({ table: 'auth:signup', method: 'POST', rows: { email } });
      // confirmation switched off in this mock, so a session comes straight back
      return send(200, { access_token: tokenFor(uid), refresh_token: 'r', token_type: 'bearer' });
    }

    if (url.pathname === '/auth/v1/token') {
      const { email, password } = JSON.parse(body || '{}');
      const u = USERS[email];
      if (!u || u.pw !== password) return send(400, { error_description: 'Invalid login credentials' });
      return send(200, { access_token: tokenFor(u.uid), refresh_token: 'r', token_type: 'bearer' });
    }

    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const fn = url.pathname.slice('/rest/v1/rpc/'.length);
      const args = body ? JSON.parse(body) : {};
      received.push({ table: 'rpc:' + fn, method: 'POST', rows: args });
      /* the database hands a shop the rate it will be billed without
         showing it the market rate behind it (02_security.sql) */
      /* a whole day at once, as the database does it */
      if (fn === 'purchase_rates_on') {
        const out = [];
        Object.keys(RATES).forEach(k => {
          const [d, code] = k.split('|');
          if (d === args.p_date) out.push({ product_code: code,
                                            rate: Math.round(RATES[k] * 1.04 * 10000) / 10000 });
        });
        return send(200, out);
      }
      if (fn === 'purchase_rate') {
        const mk = RATES[args.p_date + '|' + args.p_code];
        return send(200, mk === undefined ? null : Math.round(mk * 1.04 * 10000) / 10000);
      }
      /* clearing a day outright, for anybody signed in — the testing
         function in 02_security.sql. A project that has not been given
         it yet answers as PostgREST does when a function is missing,
         and the app falls back to deleting table by table. */
      if (fn === 'wipe_day') {
        if (opts.noWipeFn) return send(404, { code: 'PGRST202',
          message: "Could not find the function public.wipe_day(p_date) in the schema cache" });
        const d = args.p_date;
        const drop = arr => { for (let i = arr.length - 1; i >= 0; i--)
                                if (arr[i].trade_date === d) arr.splice(i, 1); };
        const gone = INDENTS.filter(x => x.trade_date === d).map(x => x.id);
        for (let i = ILINES.length - 1; i >= 0; i--)
          if (gone.indexOf(ILINES[i].indent_id) > -1) ILINES.splice(i, 1);
        drop(INDENTS); drop(PACKED); drop(SHIPS); drop(ISSUES);
        Object.keys(RATES).forEach(k => { if (k.indexOf(d + '|') === 0) delete RATES[k]; });
        return send(200, null);
      }
      /* renaming a vendor group, the one call that moves everything —
         rename_group in 02_security.sql. A project without it answers
         the way PostgREST does for a function it cannot find. */
      if (fn === 'rename_group') {
        if (opts.noRenameFn) return send(404, { code: 'PGRST202',
          message: "Could not find the function public.rename_group(p_new, p_old) in the schema cache" });
        const was = args.p_old, now = String(args.p_new || '').trim();
        const known = [{ name: 'Ooty' }, { name: 'Manual order' }].concat(EXTRA_GROUPS);
        if (!now) return send(400, { code: 'P0001', message: 'a vendor group needs a name' });
        if (!known.some(x => x.name === was))
          return send(400, { code: 'P0001', message: 'there is no vendor group called ' + was });
        if (known.some(x => x.name === now))
          return send(400, { code: 'P0001', message: 'there is already a vendor group called ' + now });
        EXTRA_GROUPS.forEach(x => { if (x.name === was) x.name = now; });
        if (!EXTRA_GROUPS.some(x => x.name === now)) EXTRA_GROUPS.push({ name: now, manual: false, sort_ord: 1 });
        RENAMED.push(was);      // and the old name stops being served
        EXTRA_MAPPING.forEach(m => { if (m.group_name === was) m.group_name = now; });
        return send(200, null);
      }
      if (fn === 'list_people') return send(200, PEOPLE);
      if (fn === 'invite_person') {
        PEOPLE.push({ kind: 'invite', id: 'inv-' + PEOPLE.length,
                      phone: args.p_phone, full_name: args.p_full_name,
                      role: args.p_role, client_id: args.p_client_id,
                      shop_id: args.p_shop_id, active: false });
        return send(200, 'inv-new');
      }
      if (fn === 'set_person_active') {
        const u = PEOPLE.find(x => x.id === args.p_user);
        if (u) u.active = args.p_active;
        return send(200, null);
      }
      if (fn === 'set_person_role') {
        const u = PEOPLE.find(x => x.id === args.p_user);
        if (u) u.role = args.p_role;
        return send(200, null);
      }
      if (fn === 'cancel_invite') {
        const i = PEOPLE.findIndex(x => x.id === args.p_invite);
        if (i > -1) PEOPLE.splice(i, 1);
        return send(200, null);
      }
      return send(200, null);
    }

    if (url.pathname === '/rest/v1/app_users') {
      const u = Object.values(USERS).find(x => x.uid === uidOf(req));
      if (!u || !u.row) return send(200, []);
      /* an owner may write app_users, which is what the screen falls back
         to when the project's function cannot delete */
      if (req.method === 'DELETE') {
        if (u.row.role !== 'owner') return send(403, { message: 'permission denied' });
        const id = (url.searchParams.get('id') || '').replace(/^eq\./, '');
        received.push({ table: 'app_users?id=eq.' + id, method: 'DELETE', rows: null });
        const i = PEOPLE.findIndex(r => r.id === id);
        if (i > -1) PEOPLE.splice(i, 1);
        /* only the access row goes: the auth account keeps the email,
           which is exactly the orphan the old delete path left behind */
        const em = Object.keys(USERS).find(e => USERS[e].uid === id);
        if (em) USERS[em].row = null;
        return send(204, null);
      }
      /* RLS as the database has it: an owner may read everyone in the
         client, anybody else only themselves. Their own row is put last
         on purpose — an unfiltered read must not be allowed to pass for
         "me" just because something else sorted first. */
      const visible = u.row.role === 'owner'
        ? PEOPLE.filter(r => r.kind === 'user' && r.id !== u.uid).concat([u.row])
        : [u.row];
      const wanted = (url.searchParams.get('id') || '').replace(/^eq\./, '');
      return send(200, wanted ? visible.filter(r => r.id === wanted) : visible);
    }

    if (url.pathname.startsWith('/rest/v1/')) {
      const table = url.pathname.slice('/rest/v1/'.length);
      const name = table.split('?')[0];

      /* An indent line is keyed by its header's id. The app works in
         days and shops and has to look the id up before it can send
         one — so the mock keeps the headers it was given and answers
         that lookup, exactly as PostgREST would. */
      if (req.method === 'GET' && name === 'indents') {
        const d = (url.searchParams.get('trade_date') || '').replace(/^eq\./, '');
        const s = (url.searchParams.get('shop_id') || '').replace(/^eq\./, '');
        return send(200, INDENTS.filter(i => (!d || i.trade_date === d) &&
                                             (!s || i.shop_id === s)));
      }
      /* clearing a day: everything with that trade date goes, and the
         indent lines go with their headers as the cascade would */
      if (req.method === 'DELETE' && url.searchParams.get('trade_date')) {
        const d = (url.searchParams.get('trade_date') || '').replace(/^eq\./, '');
        received.push({ table: name, method: 'DELETE', rows: { trade_date: d } });
        const drop = (arr) => { for (let i = arr.length - 1; i >= 0; i--)
                                  if (arr[i].trade_date === d) arr.splice(i, 1); };
        if (name === 'indents') {
          const gone = INDENTS.filter(x => x.trade_date === d).map(x => x.id);
          for (let i = ILINES.length - 1; i >= 0; i--)
            if (gone.indexOf(ILINES[i].indent_id) > -1) ILINES.splice(i, 1);
          drop(INDENTS);
        }
        if (name === 'packed') drop(PACKED);
        if (name === 'shipments') drop(SHIPS);
        if (name === 'day_rates') Object.keys(RATES).forEach(k => {
          if (k.indexOf(d + '|') === 0) delete RATES[k];
        });
        if (name === 'vendor_order_lines') return send(404, { code: 'PGRST205',
          message: "Could not find the table 'public.vendor_order_lines' in the schema cache" });
        return send(204, null);
      }

      if (req.method === 'GET' && (name === 'packed' || name === 'shipments')) {
        const store = name === 'packed' ? PACKED : SHIPS;
        const d = (url.searchParams.get('trade_date') || '').replace(/^eq\./, '');
        return send(200, store.filter(r => !d || r.trade_date === d));
      }
      /* A write the database would refuse must be refused before any
         handler stores it, or the mock keeps rows the server never had. */
      const COLS = schemaColumns();
      if (req.method === 'POST' && body && (COLS[name] || (opts.behindColumns && opts.behindColumns[name]))) {
        const rows0 = JSON.parse(body);
        /* PostgREST refuses a bulk insert whose rows carry different
           keys — the exact 400 a phone hit live when its queue mixed
           rows from two builds of the app */
        if (Array.isArray(rows0) && rows0.length > 1) {
          const shape = Object.keys(rows0[0]).sort().join(',');
          if (rows0.some(r => Object.keys(r).sort().join(',') !== shape)) {
            return send(400, { code: 'PGRST102', message: 'All object keys must match' });
          }
        }
        for (const row of (Array.isArray(rows0) ? rows0 : [rows0])) {
          const behind = opts.behindColumns && opts.behindColumns[name]
            ? Object.keys(row).find(c => opts.behindColumns[name].indexOf(c) > -1) : null;
          if (behind) return send(400, { code: 'PGRST204',
            message: "Could not find the '" + behind + "' column of '" + name +
                     "' in the schema cache" });
          const bad = COLS[name] ? Object.keys(row).filter(c => COLS[name].indexOf(c) < 0) : [];
          if (bad.length) {
            received.push({ table: name, method: 'POST', rows: rows0, refused: bad });
            return send(400, { code: 'PGRST204',
              message: "Could not find the '" + bad[0] + "' column of '" + name +
                       "' in the schema cache" });
          }
        }
      }

      if (req.method === 'POST' && name === 'day_rates') {
        (body ? JSON.parse(body) : []).forEach(r => {
          RATES[r.trade_date + '|' + r.product_code] = Number(r.rate);
        });
      }
      if (req.method === 'POST' && (name === 'packed' || name === 'shipments')) {
        const store = name === 'packed' ? PACKED : SHIPS;
        (body ? JSON.parse(body) : []).forEach(r => {
          const had = store.filter(x => x.trade_date === r.trade_date && x.shop_id === r.shop_id &&
                                        (name === 'shipments' || x.product_code === r.product_code))[0];
          if (had) Object.assign(had, r); else store.push(Object.assign({}, r));
        });
      }
      if (req.method === 'GET' && name === 'indent_lines') {
        /* one flaky moment, then fine — the shape of a real network:
           the headers read answered and this one did not */
        if (opts.failLines) { opts.failLines = false; return send(500, { message: 'boom' }); }
        const inp = (url.searchParams.get('indent_id') || '');
        const ids = (inp.match(/in\.\((.*)\)/) || [])[1];
        const want = ids ? ids.split(',') : null;
        return send(200, ILINES.filter(l => !want || want.indexOf(l.indent_id) > -1));
      }
      if (req.method === 'POST' && name === 'indents') {
        (body ? JSON.parse(body) : []).forEach(r => {
          const had = INDENTS.filter(i => i.trade_date === r.trade_date && i.shop_id === r.shop_id)[0];
          if (had) Object.assign(had, r);
          else INDENTS.push(Object.assign({ id: 'ind-' + (INDENTS.length + 1) }, r));
        });
      }
      if (req.method === 'POST' && name === 'indent_lines') {
        (body ? JSON.parse(body) : []).forEach(r => {
          const had = ILINES.filter(l => l.indent_id === r.indent_id &&
                                         l.product_code === r.product_code)[0];
          if (had) had.qty = r.qty; else ILINES.push(Object.assign({}, r));
        });
      }
      if (req.method === 'DELETE' && name === 'indent_lines') {
        const id = (url.searchParams.get('indent_id') || '').replace(/^eq\./, '');
        const pc = (url.searchParams.get('product_code') || '').replace(/^eq\./, '');
        for (let i = ILINES.length - 1; i >= 0; i--) {
          if (ILINES[i].indent_id === id && ILINES[i].product_code === pc) ILINES.splice(i, 1);
        }
      }

      /* The columns each table actually has — read out of
         supabase/01_schema.sql rather than kept by hand here, because a
         hand-kept copy goes stale and then the mock waves through a
         write the real database would refuse. That is not theoretical:
         indent_lines was sent trade_date and shop_id for months and
         PostgREST rejected every push carrying a line, and later the
         invoice grew six columns this list did not have. */

      /* the contact master: kept, so a contact survives a reload the
         way it does on a real project */
      if (req.method === 'GET' && name === 'contacts') return send(200, CONTACTS);
      if (req.method === 'GET' && name === 'contact_bank') return send(200, CBANK);
      if (req.method === 'POST' && (name === 'contacts' || name === 'contact_bank')) {
        const store = name === 'contacts' ? CONTACTS : CBANK;
        const key = name === 'contacts' ? 'id' : 'contact_id';
        (body ? JSON.parse(body) : []).forEach(r => {
          const ex = store.find(x => x[key] === r[key]);
          if (ex) Object.assign(ex, r); else store.push(r);
        });
        received.push({ table: name, method: 'POST', rows: body ? JSON.parse(body) : null });
        return send(201, {});
      }

      if (req.method === 'GET' && name === 'delivery_issues') return send(200, ISSUES);
      if (req.method === 'POST' && name === 'delivery_issues') {
        (body ? JSON.parse(body) : []).forEach(r => {
          const had = ISSUES.find(x => x.trade_date === r.trade_date &&
            x.shop_id === r.shop_id && x.product_code === r.product_code);
          if (had) Object.assign(had, r); else ISSUES.push(Object.assign({}, r));
        });
        received.push({ table: name, method: 'POST', rows: body ? JSON.parse(body) : null });
        return send(201, {});
      }
      if (req.method === 'DELETE' && name === 'delivery_issues') {
        const d = (url.searchParams.get('trade_date') || '').replace(/^eq\./, '');
        const sh = (url.searchParams.get('shop_id') || '').replace(/^eq\./, '');
        const pc = (url.searchParams.get('product_code') || '').replace(/^eq\./, '');
        for (let i = ISSUES.length - 1; i >= 0; i--) {
          if ((!d || ISSUES[i].trade_date === d) && (!sh || ISSUES[i].shop_id === sh) &&
              (!pc || ISSUES[i].product_code === pc)) ISSUES.splice(i, 1);
        }
        received.push({ table: name, method: 'DELETE', rows: null });
        return send(204, null);
      }

      if (req.method === 'GET' && table.startsWith('products')) return send(200, EXTRA_PRODUCTS);
      if (req.method === 'GET' && table.startsWith('product_groups')) return send(200, EXTRA_MAPPING);

      /* editing one that is already there, and taking one off the list.
         Both are filtered by code the way PostgREST is, so the mock has
         to read the filter rather than the body. */
      const codeFilter = () => (url.searchParams.get('code') || '').replace(/^eq\./, '');
      if (req.method === 'PATCH' && name === 'products') {
        const code = codeFilter(), patch = body ? JSON.parse(body) : {};
        const row = EXTRA_PRODUCTS.find(x => x.code === code);
        if (row) Object.assign(row, patch);
        received.push({ table: name, method: 'PATCH', code: code, rows: patch });
        return send(200, {});
      }
      if (req.method === 'DELETE' && name === 'products') {
        const code = codeFilter();
        /* a product another device has already traded: the real database
           refuses on the foreign key, and the app has to turn that into
           a sentence rather than a constraint name */
        if (LOCKED.indexOf(code) > -1) return send(409, { code: '23503',
          message: 'update or delete on table "products" violates foreign key constraint '
                 + '"day_rates_product_code_fkey" on table "day_rates"' });
        for (let i = EXTRA_PRODUCTS.length - 1; i >= 0; i--)
          if (EXTRA_PRODUCTS[i].code === code) EXTRA_PRODUCTS.splice(i, 1);
        // product_groups goes with it, on delete cascade
        for (let i = EXTRA_MAPPING.length - 1; i >= 0; i--)
          if (EXTRA_MAPPING[i].product_code === code) EXTRA_MAPPING.splice(i, 1);
        received.push({ table: name, method: 'DELETE', code: code, rows: null });
        return send(204, null);
      }
      if (req.method === 'GET' && table.startsWith('vendor_groups'))
        return send(200, [{ name: 'Ooty', manual: false, sort_ord: 1 },
                          { name: 'Manual order', manual: true, sort_ord: 9 }]
                         .concat(EXTRA_GROUPS)
                         .filter(g => RENAMED.indexOf(g.name) < 0));
      if (req.method === 'POST' || req.method === 'DELETE') {
        /* both of these are upserts on a key, so a second write to the
           same product replaces rather than piles up */
        if (table.startsWith('products')) {
          (body ? JSON.parse(body) : []).forEach(r => {
            const ex = EXTRA_PRODUCTS.find(x => x.code === r.code);
            if (ex) Object.assign(ex, r); else EXTRA_PRODUCTS.push(r);
          });
        }
        if (table.startsWith('product_groups')) {
          (body ? JSON.parse(body) : []).forEach(r => {
            const ex = EXTRA_MAPPING.find(m => m.product_code === r.product_code);
            if (ex) ex.group_name = r.group_name; else EXTRA_MAPPING.push(r);
          });
        }
        if (table.startsWith('vendor_groups')) {
          (body ? JSON.parse(body) : []).forEach(r => EXTRA_GROUPS.push(r));
        }
        received.push({ table, method: req.method, rows: body ? JSON.parse(body) : null });
        return send(201, {});
      }
      return send(200, []);            // empty pull
    }
    send(404, {});
  });
});

// Each suite requires this file, so a leftover instance from a previous
// run would otherwise crash the next one with EADDRINUSE. If something
// is already serving on the port, use it rather than failing.
srv.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.log('mock supabase already running on 8123');
  else throw e;
});
srv.listen(8123, () => console.log('mock supabase on 8123'));
process.on('message', m => { if (m === 'dump') process.send(received); });
global.__received = received;
module.exports = { received, srv, opts };
