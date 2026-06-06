const https = require('https');

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SVC  =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SECRET_KEY;

function embedText(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: 'text-embedding-3-small', input: text.slice(0, 8000) });
    const req = https.request({
      hostname: 'api.openai.com', path: '/v1/embeddings', method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{ const p=JSON.parse(d); if(p.error) return reject(new Error(p.error.message)); resolve(p.data[0].embedding); }catch(e){reject(e);} }); });
    req.on('error', reject); req.write(body); req.end();
  });
}

// SECURITY: identity is derived from the verified Bearer token — never the client. No anonymous writes.
async function resolveCaller(event) {
  const token = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  try {
    const ures = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` } });
    const u = await ures.json();
    if (!u || !u.id) return null;
    const pres = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?supabase_uid=eq.${u.id}&select=user_id`,
      { headers: { apikey: SUPABASE_SVC, Authorization: `Bearer ${SUPABASE_SVC}` } });
    const prof = (await pres.json())[0];
    return prof ? prof.user_id : null;
  } catch (e) { return null; }
}

function saveMemory(content, embedding, userId) {
  return new Promise((resolve, reject) => {
    const host = new URL(SUPABASE_URL).hostname;
    const body = JSON.stringify({ user_id: userId, content, embedding, memory_type: 'conversation', is_synthetic: false, session_date: new Date().toISOString().split('T')[0] });
    const req = https.request({
      hostname: host, path: '/rest/v1/memories', method: 'POST',
      headers: { 'apikey': SUPABASE_SVC, 'Authorization': `Bearer ${SUPABASE_SVC}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Prefer': 'return=minimal' }
    }, (res) => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(res.statusCode)); });
    req.on('error', reject); req.write(body); req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Not Allowed' };
  if (!process.env.OPENAI_API_KEY || !SUPABASE_URL) return { statusCode: 200, body: JSON.stringify({ stored: false }) };
  try {
    const { userMessage, assistantReply } = JSON.parse(event.body || '{}'); // client userId intentionally ignored
    if (!userMessage || !assistantReply) return { statusCode: 400, body: JSON.stringify({ error: 'Missing messages' }) };
    if (userMessage.length < 5 || assistantReply.length < 10) return { statusCode: 200, body: JSON.stringify({ stored: false, reason: 'Too short' }) };

    const userId = await resolveCaller(event);
    if (!userId) return { statusCode: 401, body: JSON.stringify({ stored: false, error: 'Not authenticated' }) };

    const content = `User: ${userMessage}\nSymbio: ${assistantReply}`;
    const embedding = await embedText(content);
    const status = await saveMemory(content, embedding, userId);
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stored: true, status }) };
  } catch (error) {
    console.error('[memory-store]', error.message);
    return { statusCode: 200, body: JSON.stringify({ stored: false, error: error.message }) };
  }
};
