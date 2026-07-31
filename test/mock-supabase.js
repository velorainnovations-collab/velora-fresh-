/* A stand-in for Supabase: the same auth and PostgREST shapes the app
   talks to, so the client code can be exercised end to end offline. */
const http = require('http');

const USERS = {
  'owner@velora.example':   { pw: 'right', uid: 'aaaa0000-0000-0000-0000-00000000000a',
                              row: { id: 'aaaa0000-0000-0000-0000-00000000000a', full_name: 'Velora Owner',
                                     role: 'owner', client_id: null, shop_id: null, active: true } },
  'shop@velora.example':    { pw: 'right', uid: 'dddd0000-0000-0000-0000-00000000000d',
                              row: { id: 'dddd0000-0000-0000-0000-00000000000d', full_name: 'Kilpauk Mgr',
                                     role: 'shop', client_id: 'KPN', shop_id: 'KLP', active: true } },
  // signed up but never invited: authenticates, but has no app_users row
  'stranger@velora.example':{ pw: 'right', uid: 'ffff0000-0000-0000-0000-00000000000f', row: null },
};

const received = [];          // every write the app sent

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
      const byInvite = a.action === 'invite' || !a.password;
      if (!a.email) return send(400, { error: 'An email address is required' });
      if (!byInvite && a.password.length < 8)
        return send(400, { error: 'Use a password of at least 8 characters' });
      if (a.role === 'shop' && !a.shop_id) return send(400, { error: 'A shop login needs a shop' });
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
      if (req.method === 'GET' && table.startsWith('products')) return send(200, EXTRA_PRODUCTS);
      if (req.method === 'GET' && table.startsWith('product_groups')) return send(200, EXTRA_MAPPING);
      if (req.method === 'GET' && table.startsWith('vendor_groups'))
        return send(200, [{ name: 'Ooty', manual: false, sort_ord: 1 },
                          { name: 'Manual order', manual: true, sort_ord: 9 }]
                         .concat(EXTRA_GROUPS));
      if (req.method === 'POST' || req.method === 'DELETE') {
        if (table.startsWith('products')) {
          (body ? JSON.parse(body) : []).forEach(r => EXTRA_PRODUCTS.push(r));
        }
        if (table.startsWith('product_groups')) {
          (body ? JSON.parse(body) : []).forEach(r => EXTRA_MAPPING.push(r));
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
module.exports = { received, srv };
