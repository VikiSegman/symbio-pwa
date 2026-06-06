// netlify/functions/notifications-list.js  (SECURED v3 — server-derived identity, IDOR closed)
// Identity comes ONLY from the verified Supabase session token, resolved via user_profiles
// to the canonical app user_id. NO client-supplied uid is trusted. No guest fallback. (blueprint §4)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY; // optional; falls back to service key for the auth lookup

async function resolveUserId(event) {
  const authz = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const token = authz.startsWith('Bearer ') ? authz.slice(7) : '';
  if (!token) return { error: 'auth required', code: 401 };
  // verify the token -> get the authenticated supabase user id
  const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON_KEY || SERVICE_KEY, Authorization: `Bearer ${token}` }
  });
  if (!who.ok) return { error: 'invalid session', code: 401 };
  const u = await who.json();
  const sid = u && u.id;
  if (!sid) return { error: 'no identity', code: 401 };
  // resolve canonical app user_id from user_profiles (service key bypasses RLS for the lookup only)
  const pr = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?supabase_uid=eq.${encodeURIComponent(sid)}&select=user_id&limit=1`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
  });
  const rows = await pr.json();
  const uid = Array.isArray(rows) && rows[0] && rows[0].user_id;
  if (!uid) return { error: 'no profile', code: 403 };
  return { uid };
}

exports.handler = async (event) => {
  try {
    if (!SUPABASE_URL || !SERVICE_KEY) return json(500, { error: 'Supabase env missing' });
    const id = await resolveUserId(event);
    if (id.error) return json(id.code || 401, { error: id.error });
    const r = await fetch(`${SUPABASE_URL}/rest/v1/notifications?user_id=eq.${encodeURIComponent(id.uid)}&is_synthetic=eq.false&select=id,faculty,title,body,read_at,created_at&order=created_at.desc&limit=50`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const rows = await r.json();
    if (!r.ok) return json(500, { error: 'db', detail: rows });
    return json(200, { notifications: rows, unread: (rows || []).filter(n => !n.read_at).length });
  } catch (e) { return json(500, { error: String(e).slice(0, 200) }); }
};
function json(s, o) { return { statusCode: s, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) }; }
