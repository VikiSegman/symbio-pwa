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

// Fire-and-forget audit: log the event, never the content. Never blocks the user.
async function audit(actor, action, resource, detail) {
  try {
    const host = new URL(process.env.SUPABASE_URL).hostname;
    const svc = { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, 'Prefer': 'return=minimal' };
    await httpsPost(host, '/rest/v1/audit_log', svc, { actor, action, resource: resource || null, detail: detail || null });
  } catch(e) {}
}

// AWARENESS layer: load the user's rolling profile summary (one cheap GET by user_id).
async function getSummary(userId) {
  try {
    const host = new URL(process.env.SUPABASE_URL).hostname;
    const svc = { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}` };
    const r = await httpsGet(host, `/rest/v1/user_summaries?user_id=eq.${encodeURIComponent(userId)}&select=summary&limit=1`, svc);
    if (Array.isArray(r.body) && r.body[0] && r.body[0].summary) return r.body[0].summary;
  } catch(e) {}
  return '';
}

// GROUP ROUTING (§4): a user sees memories shared to groups they belong to.
// Group membership is resolved SERVER-SIDE from group_members (service key) — never client-controlled.
// Cross-member access is impossible by design: a non-member's userId yields no group_ids -> nothing.
// Returns [] when the user has no memberships, so this is inert until Family/Org is actually used.
async function getGroupMemories(userId) {
  try {
    const host = new URL(process.env.SUPABASE_URL).hostname;
    const svc = { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}` };
    const gm = await httpsGet(host, `/rest/v1/group_members?user_id=eq.${encodeURIComponent(userId)}&select=group_id`, svc);
    if (!Array.isArray(gm.body) || gm.body.length === 0) return [];
    const ids = gm.body.map(r => r.group_id).filter(Boolean).slice(0, 5);
    // Per-group query with the proven =eq. filter (avoids PostgREST in.() quirks). scope='group' only.
    const out = [];
    for (const gid of ids) {
      const r = await httpsGet(host, `/rest/v1/memories?group_id=eq.${encodeURIComponent(gid)}&scope=eq.group&select=content,session_date&order=created_at.desc&limit=3`, svc);
      if (Array.isArray(r.body)) for (const m of r.body) out.push(m);
    }
    return out.slice(0, 4);
  } catch(e) {}
  return [];
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

    const platformRules = `RESPONSE STYLE:
- 1-3 sentences MAX unless asked to expand.
- Bullets: 3 words per bullet, max 5.
- No filler phrases. No repetition.
- Language: match user language.`;

    // Phase 2 (AWARENESS): load the rolling profile + a little semantic memory.
    // If a profile exists, it carries "who they are" cheaply, so we pull fewer raw chats.
    const [summary, memories, groupMems] = await Promise.all([
      getSummary(userId).catch(() => ''),
      searchMemories(message, userId).catch(() => []),
      getGroupMemories(userId).catch(() => [])   // §4: inert until the user belongs to a group
    ]);
    let memBlock = '';
    if (summary) memBlock += `\n\nKNOWN ABOUT USER:\n${summary}`;
    if (memories.length > 0) {
      // With a profile present, 2 most-relevant raw memories are plenty (token saving).
      const raw = summary ? memories.slice(0, 2) : memories;
      memBlock += `\n\nRELEVANT MEMORY:\n${raw.join('\n---\n')}`;
    }
    if (groupMems.length > 0) {
      const shared = groupMems.map(m => `[${m.session_date || 'shared'}] ${m.content}`).join('\n---\n');
      memBlock += `\n\nSHARED WITH YOUR GROUP:\n${shared}`;
    }

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
    audit(userId, 'memory_write', 'memories', null).catch(() => {});

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ reply }) };

  } catch(e) {
    console.error('[ask]', e.message);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ reply: `⚠️ שגיאה: ${e.message}` }) };
  }
};
