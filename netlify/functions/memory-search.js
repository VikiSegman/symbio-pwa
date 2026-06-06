// netlify/functions/memory-search.js — SECURED (identity from verified token only)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const auth = event.headers.authorization || event.headers.Authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return { statusCode: 401, headers: CORS, body: JSON.stringify({ memories: [], error: 'sign-in required' }) };

  try {
    // 1) Verify the caller's login token -> their auth uid
    const uRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SERVICE_KEY }
    });
    if (!uRes.ok) return { statusCode: 401, headers: CORS, body: JSON.stringify({ memories: [], error: 'invalid session' }) };
    const u = await uRes.json();
    const uid = u && u.id;
    if (!uid) return { statusCode: 401, headers: CORS, body: JSON.stringify({ memories: [] }) };

    // 2) Resolve THIS caller's own canonical user_id (server-side)
    const pRes = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?supabase_uid=eq.${uid}&select=user_id&limit=1`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const profiles = pRes.ok ? await pRes.json() : [];
    const userId = profiles[0] && profiles[0].user_id;
    if (!userId) return { statusCode: 200, headers: CORS, body: JSON.stringify({ memories: [] }) };

    // 3) Return ONLY this caller's own memories
    let limit = 20;
    try { limit = Math.min(parseInt(JSON.parse(event.body || '{}').limit, 10) || 20, 50); } catch (_) {}
    const mRes = await fetch(
      `${SUPABASE_URL}/rest/v1/memories?user_id=eq.${encodeURIComponent(userId)}&select=content,memory_type,created_at&order=created_at.desc&limit=${limit}`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
    );
    const memories = mRes.ok ? await mRes.json() : [];
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ memories }) };
  } catch (e) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ memories: [], error: 'search unavailable' }) };
  }
};
