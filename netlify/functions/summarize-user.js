// summarize-user.js — Symbio AWARENESS layer (per-user rolling profile)
// End-user only. 100% Supabase. NEVER writes to Notion or owner data.
// Trigger: frontend pings at session end / pause with { uid, userId, messages }.
// Gate: only summarizes sessions with >= 4 messages.

const https = require('https');

function httpsReq(method, hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const buf = body ? JSON.stringify(body) : null;
    const h = { ...headers, 'Content-Type': 'application/json' };
    if (buf) h['Content-Length'] = Buffer.byteLength(buf);
    const req = https.request({ hostname, path, method, headers: h }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d || '{}') }); } catch(e) { resolve({ status: res.statusCode, body: d }); } });
    });
    req.on('error', reject);
    if (buf) req.write(buf);
    req.end();
  });
}

// Fire-and-forget audit: log the event, never the content. Never blocks.
async function audit(actor, action, resource, detail) {
  try {
    const host = new URL(process.env.SUPABASE_URL).hostname;
    const svc = { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, 'Prefer': 'return=minimal' };
    await httpsReq('POST', host, '/rest/v1/audit_log', svc, { actor, action, resource: resource || null, detail: detail || null });
  } catch(e) {}
}

// Resolve canonical user_id (same model as ask.js).
async function resolveUserId(uid, bodyUserId) {
  const explicit = (bodyUserId || '').trim();
  const rawUid = (uid || '').trim();
  if (rawUid) {
    try {
      const host = new URL(process.env.SUPABASE_URL).hostname;
      const svc = { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}` };
      const r = await httpsReq('GET', host, `/rest/v1/user_profiles?supabase_uid=eq.${encodeURIComponent(rawUid)}&select=user_id&limit=1`, svc, null);
      if (Array.isArray(r.body) && r.body[0] && r.body[0].user_id) return r.body[0].user_id;
    } catch(e) {}
  }
  return explicit || rawUid || '';
}

const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const { uid, userId: bodyUserId, messages } = JSON.parse(event.body || '{}');
    if (!Array.isArray(messages) || messages.length < 4) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ updated: false, reason: 'too short' }) };
    }

    const ownerUID = (process.env.OWNER_UID || '').trim();
    const isOwner  = ownerUID.length > 0 && uid === ownerUID;
    const userId = isOwner ? 'erez' : await resolveUserId(uid, bodyUserId);
    if (!userId) return { statusCode: 200, headers: CORS, body: JSON.stringify({ updated: false, reason: 'no user' }) };

    const host = new URL(process.env.SUPABASE_URL).hostname;
    const svc = { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}` };

    // Existing summary (if any).
    let prev = '';
    try {
      const r = await httpsReq('GET', host, `/rest/v1/user_summaries?user_id=eq.${encodeURIComponent(userId)}&select=summary,msg_count&limit=1`, svc, null);
      if (Array.isArray(r.body) && r.body[0]) prev = r.body[0].summary || '';
    } catch(e) {}

    // This session transcript (cap last 30 turns).
    const transcript = messages.slice(-30)
      .map(m => `${m.role === 'user' ? 'User' : 'Symbio'}: ${m.content}`).join('\n');

    // Merge into an updated profile. Grounded: only user-stated facts, no guessing.
    const prompt = `You maintain a concise private profile of a person, used by their personal AI to remember them.
Update the profile using ONLY facts the user actually stated. Do not invent or guess. Keep it under 150 words.
Write neutral third-person notes (preferences, goals, ongoing topics, important personal facts). Omit small talk.

EXISTING PROFILE:
${prev || '(none yet)'}

NEW CONVERSATION:
${transcript}

Return ONLY the updated profile text, nothing else.`;

    const ai = await httpsReq('POST', 'api.anthropic.com', '/v1/messages',
      { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      { model: 'claude-haiku-4-5', max_tokens: 400, messages: [{ role: 'user', content: prompt }] });

    const newSummary = (ai.body && ai.body.content && ai.body.content[0] && ai.body.content[0].text || '').trim();
    if (!newSummary) return { statusCode: 200, headers: CORS, body: JSON.stringify({ updated: false, reason: 'summarize failed' }) };

    // Upsert (PK = user_id). Prefer: resolution=merge-duplicates updates the row.
    const upHeaders = { ...svc, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal' };
    await httpsReq('POST', host, '/rest/v1/user_summaries', upHeaders,
      { user_id: userId, summary: newSummary.slice(0, 4000), msg_count: messages.length, updated_at: new Date().toISOString() });

    audit(userId, 'summary_update', 'user_summaries', `${messages.length} msgs`).catch(() => {});

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ updated: true }) };

  } catch(e) {
    console.error('[summarize-user]', e.message);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ updated: false, error: e.message }) };
  }
};
