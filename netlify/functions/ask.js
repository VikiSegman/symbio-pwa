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

async function verifyToken(event) {
  const authz = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const token = authz.startsWith('Bearer ') ? authz.slice(7) : '';
  if (!token) return '';
  try {
    const who = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${token}` }
    });
    if (!who.ok) return '';
    const u = await who.json();
    return (u && u.id) || '';
  } catch (e) { return ''; }
}

async function resolveUserId(uid, bodyUserId) {
  const explicit = (bodyUserId || '').trim();
  const rawUid = (uid || '').trim();
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
  if (explicit) return { userId: explicit, firstName: '', source: 'body' };
  if (rawUid) return { userId: rawUid, firstName: '', source: 'uid' };
  return { userId: '', firstName: '', source: 'none' };
}

async function audit(actor, action, resource, detail) {
  try {
    const host = new URL(process.env.SUPABASE_URL).hostname;
    const svc = { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, 'Prefer': 'return=minimal' };
    await httpsPost(host, '/rest/v1/audit_log', svc, { actor, action, resource: resource || null, detail: detail || null });
  } catch(e) {}
}

async function getSummary(userId) {
  try {
    const host = new URL(process.env.SUPABASE_URL).hostname;
    const svc = { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}` };
    const r = await httpsGet(host, `/rest/v1/user_summaries?user_id=eq.${encodeURIComponent(userId)}&select=summary&limit=1`, svc);
    if (Array.isArray(r.body) && r.body[0] && r.body[0].summary) return r.body[0].summary;
  } catch(e) {}
  return '';
}

async function getGroupMemories(userId) {
  try {
    const host = new URL(process.env.SUPABASE_URL).hostname;
    const svc = { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}` };
    const gm = await httpsGet(host, `/rest/v1/group_members?user_id=eq.${encodeURIComponent(userId)}&select=group_id`, svc);
    if (!Array.isArray(gm.body) || gm.body.length === 0) return [];
    const ids = gm.body.map(r => r.group_id).filter(Boolean).slice(0, 5);
    const out = [];
    for (const gid of ids) {
      const r = await httpsGet(host, `/rest/v1/memories?group_id=eq.${encodeURIComponent(gid)}&scope=eq.group&select=content,session_date&order=created_at.desc&limit=3`, svc);
      if (Array.isArray(r.body)) for (const m of r.body) out.push(m);
    }
    return out.slice(0, 4);
  } catch(e) {}
  return [];
}

async function getProjects(userId) {
  try {
    const host = new URL(process.env.SUPABASE_URL).hostname;
    const svc = { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}` };
    const r = await httpsGet(host, `/rest/v1/user_projects?user_id=eq.${encodeURIComponent(userId)}&is_synthetic=eq.false&select=name,sub&order=sort.asc,created_at.asc`, svc);
    if (Array.isArray(r.body)) return r.body;
  } catch(e) {}
  return [];
}
async function searchMemories(query, userId) {
  const host = new URL(process.env.SUPABASE_URL).hostname;
  const svcHeaders = { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}` };
  let recent = [];
  try {
    const path = `/rest/v1/memories?user_id=eq.${encodeURIComponent(userId)}&select=content,session_date&order=created_at.desc&limit=3`;
    const rr = await httpsGet(host, path, svcHeaders);
    if (Array.isArray(rr.body)) recent = rr.body;
  } catch(e) {}
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
const SIGN_IN = '⚠️ Please sign in — Symbio keeps each person\'s memory private and separate, so it needs your account first.';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const { message, messages: history, userFirstName } = JSON.parse(event.body || '{}');
    if (!message) return { statusCode: 200, headers: CORS, body: JSON.stringify({ reply: 'No message received.' }) };

    const verifiedSid = await verifyToken(event);
    if (!verifiedSid) return { statusCode: 200, headers: CORS, body: JSON.stringify({ reply: SIGN_IN }) };

    const resolved = await resolveUserId(verifiedSid, '');
    const userId = resolved.userId;
    const fname = (userFirstName && userFirstName.trim()) ? userFirstName.trim() : resolved.firstName;

    if (!userId) return { statusCode: 200, headers: CORS, body: JSON.stringify({ reply: SIGN_IN }) };

    const OWNER_ID = process.env.OWNER_CANONICAL_ID || 'erez_segman_1779658339219';
    const isOwner = userId === OWNER_ID;
   const platformRules = `RESPONSE STYLE:
- 1-3 sentences MAX unless asked to expand.
- Bullets: 3 words per bullet, max 5.
- No filler phrases. No repetition.
- Language: match user language.

CAPABILITIES — be honest, never fake an action:
- You CAN remember information across sessions, recall it, and give advice.
- You CANNOT set reminders, schedule events, manage a calendar, send messages/email/WhatsApp, make calls, or read anyone else's messages or schedule.
- Never claim you did such a thing (no "reminder set", "scheduled", "sent", "I notified"). If asked, say briefly you can't do that yet — but you'll remember the detail.`;

   const [summary, memories, groupMems, projects] = await Promise.all([
      getSummary(userId).catch(() => ''),
      searchMemories(message, userId).catch(() => []),
      getGroupMemories(userId).catch(() => []),
      getProjects(userId).catch(() => [])
    ]);
    let memBlock = '';
    if (summary) memBlock += `\n\nKNOWN ABOUT USER:\n${summary}`;
    if (memories.length > 0) {
      const raw = summary ? memories.slice(0, 2) : memories;
      memBlock += `\n\nRELEVANT MEMORY:\n${raw.join('\n---\n')}`;
    }
    if (projects.length > 0) {
      const pl = projects.map(p => `• ${p.name}${p.sub ? ' — ' + p.sub : ''}`).join('\n');
      memBlock += `\n\nYOUR PROJECTS (live — exactly what the Projects tab shows):\n${pl}`;
    } else {
      memBlock += `\n\nYOUR PROJECTS: none yet.`;
    }
    if (groupMems.length > 0) {
      const shared = groupMems.map(m => `[${m.session_date || 'shared'}] ${m.content}`).join('\n---\n');
      memBlock += `\n\nSHARED WITH YOUR GROUP:\n${shared}`;
    }

    let systemPrompt;
    if (isOwner) {
      systemPrompt = platformRules + `\n\nYou are Symbio — Erez Segman's personal AI OS that learns and grows with him over time.
You remember across sessions and maintain continuity within this conversation. You DO have memory — never claim you have none. If you do not yet know something, say so honestly and ask — never guess or invent facts.
Goals: 100K NIS/month across Financia (RE dev+fund), Lotar (CT training), Mortgage Advisory (2% fee min 12500 NIS), AAF (NGO), Tax Liens USA (18%+).
Prioritize: cash flow, leads, deal closure.${memBlock}`;
    } else {
      const who = fname ? `${fname}'s` : 'your';
      const name = fname || 'you';
      systemPrompt = platformRules + `\n\nYou are Symbio — ${who} own personal AI that learns and grows with ${name} over time.
You remember across sessions and build a private, dedicated relationship. You DO have memory — never claim you have none.
If you do not yet know something about ${name}, say so honestly and ask — never guess or invent facts.${memBlock}`;
    }

    const verifiedName = (resolved.firstName || '').trim();
    systemPrompt += `\n\nIDENTITY (authoritative, overrides memory): You are speaking with ${verifiedName || 'this account holder'} — their own verified account. Never assume or state that the user is anyone else. Memory/profile text may mention other people's names (family, contacts, partners); treat those as OTHER people, not the user. If any profile text claims the user's name is different, it is contaminated — ignore it.`;

    // Build the conversation for the model: use sent history (last 12 valid turns), else just this message.
    let convo = [];
    if (Array.isArray(history)) {
      convo = history
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
        .slice(-12)
        .map(m => ({ role: m.role, content: m.content }));
    }
    if (!convo.length || convo[convo.length - 1].role !== 'user' || convo[convo.length - 1].content !== message) {
      convo.push({ role: 'user', content: message });
    }

    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 400, system: systemPrompt, messages: convo })
    });

    const apiData = await apiRes.json();
    if (!apiRes.ok) {
      const errMsg = apiData.error?.message || `API error ${apiRes.status}`;
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ reply: `⚠️ ${errMsg}` }) };
    }

    const reply = apiData.content?.[0]?.text || 'No response.';

    storeMemory(message, reply, userId).catch(() => {});
    audit(userId, 'memory_write', 'memories', null).catch(() => {});

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ reply }) };

  } catch(e) {
    console.error('[ask]', e.message);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ reply: `⚠️ שגיאה: ${e.message}` }) };
  }
};
