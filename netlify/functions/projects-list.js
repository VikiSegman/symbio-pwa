// netlify/functions/projects-list.js (SECURED — server-derived identity, IDOR closed)
// Identity comes ONLY from the verified Supabase session token, resolved via user_profiles
// to the canonical app user_id (the value used in user_projects.user_id). Client uid ignored.
// Response shape {projects:[...]} + order sort.asc,created_at.asc preserved byte-identical.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY; // optional; falls back to service key for the auth lookup

async function resolveUserId(event) {
  const authz = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const token = authz.startsWith('Bearer ') ? authz.slice(7) : '';
  if (!token) return { error: 'auth required', code: 401 };
  const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON_KEY || SERVICE_KEY, Authorization: `Bearer ${token}` }
  });
  if (!who.ok) return { error: 'invalid session', code: 401 };
  const u = await who.json();
  const sid = u && u.id;
  if (!sid) return { error: 'no identity', code: 401 };
  const pr = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?supabase_uid=eq.${encodeURIComponent(sid)}&select=user_id&limit=1`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
  });
  const rows = await pr.json();
  const uid = Array.isArray(rows) && rows[0] && rows[0].user_id;
  if (!uid) return { error: 'no profile', code: 403 };
  return { uid };
}

exports.handler = async (event) => {
  const cors = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };
  try {
    if (!SUPABASE_URL || !SERVICE_KEY) return { statusCode: 500, headers: cors, body: JSON.stringify({ projects: [] }) };
    const id = await resolveUserId(event);
    if (id.error) return { statusCode: id.code || 401, headers: cors, body: JSON.stringify({ error: id.error, projects: [] }) };
    const r = await fetch(`${SUPABASE_URL}/rest/v1/user_projects?user_id=eq.${encodeURIComponent(id.uid)}&is_synthetic=eq.false&order=sort.asc,created_at.asc`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const rows = await r.json();
    return { statusCode: 200, headers: cors, body: JSON.stringify({ projects: Array.isArray(rows) ? rows : [] }) };
  } catch (e) {
    return { statusCode: 200, headers: cors, body: JSON.stringify({ projects: [] }) };
  }
};
