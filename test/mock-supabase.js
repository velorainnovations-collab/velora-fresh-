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

    if (url.pathname === '/auth/v1/token') {
      const { email, password } = JSON.parse(body || '{}');
      const u = USERS[email];
      if (!u || u.pw !== password) return send(400, { error_description: 'Invalid login credentials' });
      return send(200, { access_token: 'tok-' + u.uid, refresh_token: 'r', token_type: 'bearer' });
    }

    if (url.pathname === '/rest/v1/app_users') {
      const tok = (req.headers.authorization || '').replace('Bearer tok-', '');
      const u = Object.values(USERS).find(x => x.uid === tok);
      return send(200, u && u.row ? [u.row] : []);   // RLS: your own row, or nothing
    }

    if (url.pathname.startsWith('/rest/v1/')) {
      const table = url.pathname.slice('/rest/v1/'.length);
      if (req.method === 'POST' || req.method === 'DELETE') {
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
