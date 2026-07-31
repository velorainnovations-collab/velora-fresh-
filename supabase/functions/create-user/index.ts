// ============================================================
// Velora Fresh — create a login on the owner's behalf
//
// The owner sets the password and hands it over, rather than the person
// signing themselves up. That needs the service_role key, which bypasses
// every policy in 02_security.sql and must never reach a browser — so it
// lives here as a secret and the browser only ever calls this function.
//
// Two checks before anything is created:
//   1. the caller's own token is verified against Supabase Auth
//   2. their app_users row must say role = 'owner'
// Neither is taken from the request body; both are read server side.
//
// Deploy:
//   supabase functions deploy create-user --project-ref <ref>
//   supabase secrets set SERVICE_ROLE_KEY=<your service_role key>
// ============================================================

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
// Supabase injects SUPABASE_SERVICE_ROLE_KEY automatically; the second
// name is there for a project where it has been set by hand.
const SERVICE_KEY =
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })

type Role = 'owner' | 'admin' | 'ho' | 'shop'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405)

  // ---------- who is asking ----------
  const auth = req.headers.get('Authorization') ?? ''
  const token = auth.replace(/^Bearer\s+/i, '')
  if (!token) return json({ error: 'Not signed in' }, 401)

  const meRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: ANON_KEY },
  })
  if (!meRes.ok) return json({ error: 'Not signed in' }, 401)
  const me = await meRes.json()

  // ---------- are they an owner ----------
  // Read with the service key so this does not depend on the caller's own
  // read policy, and check the row rather than anything they sent.
  const rowRes = await fetch(
    `${SUPABASE_URL}/rest/v1/app_users?id=eq.${me.id}&select=role,active`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
  )
  const rows = rowRes.ok ? await rowRes.json() : []
  if (!rows.length || !rows[0].active || rows[0].role !== 'owner') {
    return json({ error: 'Only an owner may create a login' }, 403)
  }

  // ---------- what they asked for ----------
  let body: Record<string, string | null>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Bad request' }, 400)
  }

  // ---------- resetting an existing password ----------
  // Shop staff have no email, so there is no reset link to send them.
  // The owner sets a new password and hands it over on WhatsApp, which
  // is how they got the first one.
  if (body.action === 'reset') {
    const userId = String(body.user_id ?? '')
    const newPassword = String(body.password ?? '')
    if (!userId) return json({ error: 'Which user?' }, 400)
    if (newPassword.length < 8) return json({ error: 'Use a password of at least 8 characters' }, 400)

    const upd = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      method: 'PUT',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ password: newPassword, email_confirm: true }),
    })
    const updated = await upd.json()
    if (!upd.ok) {
      return json({ error: updated.msg ?? updated.message ?? 'Could not reset the password' },
                   upd.status)
    }
    return json({ id: userId, email: updated.email ?? null, reset: true })
  }

  const email = String(body.email ?? '').trim().toLowerCase()
  const password = String(body.password ?? '')
  const fullName = String(body.full_name ?? '').trim()
  const role = String(body.role ?? '') as Role
  const phone = body.phone ? String(body.phone).replace(/\D/g, '') : null
  const clientId = body.client_id ? String(body.client_id) : null
  const shopId = body.shop_id ? String(body.shop_id) : null

  if (!email) return json({ error: 'An email address is required' }, 400)
  if (password.length < 8) return json({ error: 'Use a password of at least 8 characters' }, 400)
  if (!['owner', 'admin', 'ho', 'shop'].includes(role)) return json({ error: 'Unknown role' }, 400)
  // the same shape rules app_users enforces, so the failure is readable
  if (role === 'shop' && !shopId) return json({ error: 'A shop login needs a shop' }, 400)
  if (role === 'shop' && !phone) return json({ error: 'A shop login needs a phone number' }, 400)
  if ((role === 'shop' || role === 'ho') && !clientId) {
    return json({ error: 'A client-side login needs a client' }, 400)
  }

  // ---------- create the account ----------
  // email_confirm: true — the owner is handing the password over in
  // person, so there is nobody to click a confirmation link.
  const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  })
  const created = await createRes.json()
  if (!createRes.ok) {
    return json({ error: created.msg ?? created.message ?? 'Could not create the account' },
                 createRes.status)
  }

  // ---------- give it its role ----------
  // A trigger links an invite on signup; this path has no invite, so the
  // row is written here. If it fails the account would exist with no
  // access, so it is removed again rather than left stranded.
  const rowWrite = await fetch(`${SUPABASE_URL}/rest/v1/app_users`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify([{
      id: created.id,
      phone: phone || null,
      full_name: fullName,
      role,
      client_id: clientId,
      shop_id: shopId,
    }]),
  })

  if (!rowWrite.ok) {
    const why = await rowWrite.text()
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${created.id}`, {
      method: 'DELETE',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    })
    return json({ error: `Account rolled back: ${why}` }, 400)
  }

  return json({ id: created.id, email, role })
})
