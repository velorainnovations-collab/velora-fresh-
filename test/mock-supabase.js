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

// products the "server" holds beyond the compiled catalogue
const EXTRA_PRODUCTS = [];
const EXTRA_MAPPING  = [];
const EXTRA_GROUPS   = [];   // vendor groups added at runtime

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
      return send(200, { access_token: 'tok-' + uid, refresh_token: 'r', token_type: 'bearer' });
    }

    if (url.pathname === '/auth/v1/token') {
      const { email, password } = JSON.parse(body || '{}');
      const u = USERS[email];
      if (!u || u.pw !== password) return send(400, { error_description: 'Invalid login credentials' });
      return send(200, { access_token: 'tok-' + u.uid, refresh_token: 'r', token_type: 'bearer' });
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
      const tok = (req.headers.authorization || '').replace('Bearer tok-', '');
      const u = Object.values(USERS).find(x => x.uid === tok);
      return send(200, u && u.row ? [u.row] : []);   // RLS: your own row, or nothing
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

srv.listen(8123, () => console.log('mock supabase on 8123'));
process.on('message', m => { if (m === 'dump') process.send(received); });
global.__received = received;
module.exports = { received, srv };
