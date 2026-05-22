const https = require('https');

// ── Memory: embed + store after reply ─────────────────────────────────────
function embedAndStore(userMessage, reply) {
  const content = `User: ${userMessage}\nSymbio: ${reply}`;
  const body = JSON.stringify({ model: 'text-embedding-3-small', input: content.slice(0, 4000) });
  const req = https.request({
    hostname: 'api.openai.com', path: '/v1/embeddings', method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, (res) => {
    let d = ''; res.on('data', c => d += c);
    res.on('end', () => {
      try {
        const embedding = JSON.parse(d).data?.[0]?.embedding;
        if (!embedding || !process.env.SUPABASE_URL) return;
        const host = new URL(process.env.SUPABASE_URL).hostname;
        const sb = JSON.stringify({ user_id: 'erez', content, embedding, memory_type: 'conversation', session_date: new Date().toISOString().split('T')[0] });
        const r2 = https.request({
          hostname: host, path: '/rest/v1/memories', method: 'POST',
          headers: { 'apikey': process.env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(sb), 'Prefer': 'return=minimal' }
        }, () => { console.log('[ask] memory stored'); });
        r2.on('error', e => console.error('[ask] supabase error:', e.message));
        r2.write(sb); r2.end();
      } catch(e) { console.error('[ask] embed error:', e.message); }
    });
  });
  req.on('error', e => console.error('[ask] openai error:', e.message));
  req.write(body); req.end();
}

// ── Main handler ──────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  try {
    const { message, project } = JSON.parse(event.body || '{}');
    if (!message) return { statusCode: 400, body: JSON.stringify({ error: 'No message' }) };

    const platformRules = `RESPONSE STYLE (non-negotiable):
- Default: 1-3 sentences MAX. Never longer unless user asks for more.
- If listing items: bullet points, 3 words per bullet, max 5 bullets.
- Never repeat what was just said. Never add filler phrases.
- Never start with "Of course", "Great question", "Certainly" or similar.
- After giving a short answer: stop. Wait. Let the user lead.
- Language: respond in the SAME language the user used. Mixed He/En input → mixed He/En output.
- Never switch languages mid-response unless user does first.`;

    const userContext = `You are Symbio — Erez Segman's personal AI operating system. Direct, sharp, Hebrew/English bilingual. Act as a trusted senior advisor who knows everything about Erez's world.
Active project: ${project || 'general'}.
User: Erez Segman. Goals: 100K NIS/month across Financia (RE dev, Bat Yam Tama38/2, Herzliya permit), Lotar (CT training, Farm Club, Africa pipeline), Mortgage Advisory (2% fee min 12,500 NIS), AAF (NGO donations), Tax Liens USA (Baltimore 18%+).`;

    const system = platformRules + '\n' + userContext;

    // Step 1: Call Claude — always first, always fast
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: system,
        messages: [{ role: 'user', content: message }]
      })
    });

    const data = await res.json();
    const reply = data.content?.[0]?.text || data.error?.message || 'אין תגובה';
    console.log('[ask] reply length:', reply.length);

    // Step 2: Store memory in background — never blocks the response
    if (reply.length > 10) embedAndStore(message, reply);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reply })
    };

  } catch (error) {
    console.error('[ask] error:', error.message);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
