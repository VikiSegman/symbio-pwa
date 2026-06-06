
memory-search.SECURED.js

דף
1
/
1
100%
// netlify/functions/memory-search.js  (SECURED — server-derived identity, IDOR closed)
// BEFORE: trusted body.userId and defaulted to 'erez' (owner) when none supplied -> unauth read of owner memories.
// AFTER: identity ONLY from the verified Supabase session token -> user_profiles.user_id (canonical).
// No client userId trusted; no owner-default; service key used for the RPC AFTER identity is proven.
const https = require('https');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY; // optional; falls back to service key for the auth lookup

function embedText(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: 'text-embedding-3-small', input: text.slice(0, 2000) });
    const req = https.request({
      hostname: 'api.openai.com', path: '/v1/embeddings', method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{ const p=JSON.parse(d); if(p.error) return reject(new Error(p.error.message)); resolve(p.data[0].embedding); }catch(e){reject(e);} }); });
    req.on('error',reject); req.write(body); req.end();
  });
}

async function resolveUserId(event) {
  const authz = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const token = authz.startsWith('Bearer ') ? authz.slice(7) : '';
  if (!token) return { error: 'auth required' };
  const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON_KEY || SERVICE_KEY, Authorization: `Bearer ${token}` } });
  if (!who.ok) return { error: 'invalid session' };
  const u = await who.json();
  const sid = u && u.id;
  if (!sid) return { error: 'no identity' };
  const pr = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?supabase_uid=eq.${encodeURIComponent(sid)}&select=user_id&limit=1`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
  const rows = await pr.json();
  const uid = Array.isArray(rows) && rows[0] && rows[0].user_id;
  if (!uid) return { error: 'no profile' };
  return { uid };
}

async function searchMemories(embedding, userId, limit) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_memories`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query_embedding: embedding, match_threshold: 0.70, match_count: limit, filter_user_id: userId })
  });
  try { return await r.json(); } catch (e) { return []; }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Not Allowed' };
  const cors = { 'Content-Type': 'application/json' };
  if (!process.env.OPENAI_API_KEY || !SUPABASE_URL || !SERVICE_KEY) return { statusCode: 200, headers: cors, body: JSON.stringify({ memories: [] }) };
  try {
    const id = await resolveUserId(event);
    if (id.error) return { statusCode: 401, headers: cors, body: JSON.stringify({ error: id.error, memories: [] }) };
    const { query, limit } = JSON.parse(event.body || '{}');   // NOTE: userId from body is intentionally ignored
    if (!query) return { statusCode: 200, headers: cors, body: JSON.stringify({ memories: [] }) };
    const embedding = await embedText(query);
    const memories = await searchMemories(embedding, id.uid, Math.min(limit || 5, 10));
    const formatted = (memories || []).map(m => ({ content: m.content, date: m.session_date, similarity: Math.round((m.similarity || 0) * 100) }));
    return { statusCode: 200, headers: cors, body: JSON.stringify({ memories: formatted }) };
  } catch (error) {
    console.error('[memory-search]', error.message);
    return { statusCode: 200, headers: cors, body: JSON.stringify({ memories: [] }) };
  }
};
המערכת מציגה את memory-search.SECURED.js.
