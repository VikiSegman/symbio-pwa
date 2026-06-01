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

async function searchMemories(query, userId) {
  try {
    const r = await httpsPost('api.openai.com', '/v1/embeddings',
      { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
      { model: 'text-embedding-3-small', input: query.slice(0, 4000) }
    );
    if (r.body.error) return [];
    const embedding = r.body.data[0].embedding;
    const host = new URL(process.env.SUPABASE_URL).hostname;
    const r2 = await httpsPost(host, '/rest/v1/rpc/match_memories',
      { 'apikey': process.env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}` },
      { query_embedding: embedding, match_threshold: 0.72, match_count: 4, filter_user_id: userId }
    );
    return (Array.isArray(r2.body) ? r2.body : []).map(m => `[${m.session_date || 'past'}] ${m.content}`);
  } catch(e) { return []; }
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
      { 'apikey': process.env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`, 'Prefer': 'return=minimal' },
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

    // Phase 1 (§4): NO shared 'guest' pool. Require a real, unique identity.
    // Every user is scoped to their OWN id so memory stays private and isolated.
    const realId = (bodyUserId || uid || '').trim();
    if (!isOwner && !realId) {
      return { statusCode: 200, headers: CORS,
        body: JSON.stringify({ reply: '⚠️ Please sign in — Symbio keeps each person\'s memory private and separate, so it needs your account first.' }) };
    }
    const userId = isOwner ? 'erez' : realId;

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
      const who  = userFirstName ? `${userFirstName}'s` : 'your';
      const name = userFirstName || 'you';
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
