const https = require('https');

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const buf = JSON.stringify(body);
    const req = https.request(
      { hostname, path, method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(buf) } },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch(e) { resolve({ status: res.statusCode, body: d }); } }); }
    );
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

function httpsGet(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method: 'GET', headers: { ...headers } },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch(e) { resolve({ status: res.statusCode, body: d }); } }); }
    );
    req.on('error', reject);
    req.end();
  });
}

// Resolve ONE canonical user_id per human, so memory never scatters across
// uid vs user_id. Looks up user_profiles by supabase_uid (the uid) and returns
// the stable text user_id. Falls back to the explicit bodyUserId if given.
async function resolveUserId(uid, bodyUserId) {
  const explicit = (bodyUserId || '').trim();
  const rawUid = (uid || '').trim();
  // Prefer profile lookup by uid (most reliable, path-independent).
  if (rawUid) {
    try {
      const host = new URL(process.env.SUPABASE_URL).hostname;
      const svc = { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}` };
      const path = `/rest/v1/user_profiles?supabase_uid=eq.${encodeURIComponent(rawUid)}&select=user_id,first_name&limit=1`;
      const r = await httpsGet(host, path, svc);
      if (Array.isArray(r.body) && r.body[0] && r.body[0].user_id) {
        return { userId: r.body[0].user_id, firstName: r.body[0].first_name || '', source: 'profile' };
      }
    } catch(e) {}
  }
  // Fallbacks: explicit bodyUserId, else the raw uid (last resort).
  if (explicit) return { userId: explicit, firstName: '', source: 'body' };
  if (rawUid)   return { userId: rawUid,   firstName: '', source: 'uid' };
  return { userId: '', firstName: '', source: 'none' };
}

async function searchMemories(query, userId) {
  const host = new URL(process.env.SUPABASE_URL).hostname;
  const svcHeaders = { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}` };

  // 1) RECENCY BASELINE: always pull this user's most recent memories (GET via REST).
  let recent = [];
  try {
    const path = `/rest/v1/memories?user_id=eq.${encodeURIComponent(userId)}&select=content,session_date&order=created_at.desc&limit=3`;
    const rr = await httpsGet(host, path, svcHeaders);
    if (Array.isArray(rr.body)) recent = rr.body;
  } catch(e) {}

  // 2) SEMANTIC MATCH: embed the query and find relevant memories (lower threshold = more recall).
  let semantic = [];
  try {
    const r = await httpsPost('api.openai.com', '/v1/embeddings',
      { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
      { model: 'text-embedding-3-small', input: query.slice(0, 4000) }
    );
    if (!r.body.error) {
      const embedding = r.body.data[0].embedding;
      const r2 = await httpsPost(host, '/rest/v1/rpc/match_memories', svcHeaders,
        { query_embedding: embedding, match_threshold: 0.35, match_count: 4, filter_user_id: userId }
      );
      if (Array.isArray(r2.body)) semantic = r2.body;
    }
  } catch(e) {}

  // 3) MERGE + DEDUPE (semantic first, then recent), cap at 5.
  const seen = new Set();
  const out = [];
  for (const m of [...semantic, ...recent]) {
    const key = (m.content || '').slice(0, 60);
    if (key && !seen.has(key)) { seen.add(key); out.push(`[${m.session_date || 'past'}] ${m.content}`); }
    if (out.length >= 5) break;
  }
  return out;
}

async function storeMemory(userMessage, assistantReply, userId) {
  try {
    if (userMessage.length < 5 || assistantReply.length < 10) return;
    const content = `User: ${userMessage}\nSymbio: ${assistantReply}`;
    const r = await httpsPost('api.openai.com', '/v1/embeddings',
      { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
      { model: 'text-embedding-3-small', input: content }
    );
    if (r.body.error) return;
    const host = new URL(process.env.SUPABASE_URL).hostname;
    await httpsPost(host, '/rest/v1/memories',
      { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, 'Prefer': 'return=minimal' },
      { user_id: userId, content, embedding: r.body.data[0].embedding, memory_type: 'conversation', session_date: new Date
