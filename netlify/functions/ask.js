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
      { user_id: userId, content, embedding: r.body.data[0].embedding, memory_type: 'conversation', session_date: new Date().toISOString().split('T')[0] }
    );
  } catch(e) {}
}

const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    // Phase 1 (§1): also read userFirstName + userId already sent by the frontend
    const { message, uid, userFirstName, userId: bodyUserId } = JSON.parse(event.body || '{}');
    if (!message) return { statusCode: 200, headers: CORS, body: JSON.stringify({ reply: 'No message received.' }) };

    const ownerUID = (process.env.OWNER_UID || '').trim();
    const isOwner  = ownerUID.length > 0 && uid === ownerUID;

    // CANONICAL IDENTITY (§1/§4): resolve ONE stable user_id per human via
    // user_profiles lookup, so memory never scatters across uid vs user_id,
    // regardless of which frontend path calls this function.
    const resolved = await resolveUserId(uid, bodyUserId);
    const userId = isOwner ? 'erez' : resolved.userId;
    // Prefer the name the frontend sent; fall back to the profile's first_name.
    const fname = (userFirstName && userFirstName.trim()) ? userFirstName.trim() : resolved.firstName;

    // No shared 'guest' pool. Require a real identity.
    if (!isOwner && !userId) {
      return { statusCode: 200, headers: CORS,
        body: JSON.stringify({ reply: '⚠️ Please sign in — Symbio keeps each person\'s memory private and separate, so it needs your account first.' }) };
    }

    // DEBUG SWITCH (owner testing only — remove before public launch):
    // send the exact message "__DEBUG__" to get a pipeline readout instead of a chat reply.
    if (message.trim() === '__DEBUG__') {
      let recentCount = -1, semErr = null;
      try { const probe = await searchMemories('what do you remember about me', userId); recentCount = probe.length; }
      catch(e){ semErr = e.message; }
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ reply:
        'DEBUG\n' +
        'received uid: ' + (uid||'(none)') + '\n' +
        'received bodyUserId: ' + (bodyUserId||'(none)') + '\n' +
        'received userFirstName: ' + (userFirstName||'(none)') + '\n' +
        'isOwner: ' + isOwner + '\n' +
        'RESOLVED user_id: ' + (userId||'(none)') + '  [source: ' + resolved.source + ']\n' +
        'resolved firstName: ' + (fname||'(none)') + '\n' +
        'memories found for this user_id: ' + recentCount + (semErr ? ('\nsearch error: ' + semErr) : '')
      }) };
    }

    const platformRules = `RESPONSE STYLE:
- 1-3 sentences MAX unless asked to expand.
- Bullets: 3 words per bullet, max 5.
- No filler phrases. No repetition.
- Language: match user language.`;

    // Phase 1 (§1): memory ON for EVERY valid user, each scoped to their own userId.
    const memories = await searchMemories(message, userId).catch(() => []);
    const memBlock = memories.length > 0 ? `\n\nRELEVANT MEMORY:\n${memories.join('\n---\n')}` : '';

    let systemPrompt;
    if (isOwner) {
      // Owner: full OS persona + Erez's goals (kept owner-only — §3, no goal bleed).
      systemPrompt = platformRules + `\n\nYou are Symbio — Erez Segman's personal AI OS.
Goals: 100K NIS/month across Financia (RE dev+fund), Lotar (CT training), Mortgage Advisory (2% fee min 12500 NIS), AAF (NGO), Tax Liens USA (18%+).
Prioritize: cash flow, leads, deal closure.${memBlock}`;
    } else {
      // Phase 1 (§1, §3, §11e, §14h): every user gets their OWN dedicated Symbio,
      // personalized by name from registration, with NO owner goals, plus the honesty rule.
      const who  = fname ? `${fname}'s` : 'your';
      const name = fname || 'you';
      systemPrompt = platformRules + `\n\nYou are Symbio — ${who} own personal AI that learns and grows with ${name} over time.
You remember across sessions and build a private, dedicated relationship. You DO have memory — never claim you have none.
If you do not yet know something about ${name}, say so honestly and ask — never guess or invent facts.${memBlock}`;
    }

    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 400, system: systemPrompt, messages: [{ role: 'user', content: message }] })
    });

    const apiData = await apiRes.json();
    if (!apiRes.ok) {
      const errMsg = apiData.error?.message || `API error ${apiRes.status}`;
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ reply: `⚠️ ${errMsg}` }) };
    }

    const reply = apiData.content?.[0]?.text || 'No response.';

    // Phase 1 (§1): store memory for EVERY valid user, scoped to their own userId.
    storeMemory(message, reply, userId).catch(() => {});

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ reply }) };

  } catch(e) {
    console.error('[ask]', e.message);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ reply: `⚠️ שגיאה: ${e.message}` }) };
  }
};
