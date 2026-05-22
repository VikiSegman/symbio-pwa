const https = require('https');

// ── Memory helpers ────────────────────────────────────────────────────────
async function fetchMemories(query) {
  try {
    const body = JSON.stringify({ query, userId: 'erez', limit: 5 });
    return await new Promise((resolve) => {
      const req = https.request({
        hostname: process.env.URL ? new URL(process.env.URL).hostname : 'snazzy-paprenjak-7e69b9.netlify.app',
        path: '/.netlify/functions/memory-search',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, (res) => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d).memories || []); } catch(e) { resolve([]); } });
      });
      req.on('error', () => resolve([]));
      req.setTimeout(3000, () => { req.destroy(); resolve([]); });
      req.write(body); req.end();
    });
  } catch(e) { return []; }
}

function storeMemory(userMessage, assistantReply) {
  try {
    const body = JSON.stringify({ userMessage, assistantReply, userId: 'erez' });
    const req = https.request({
      hostname: process.env.URL ? new URL(process.env.URL).hostname : 'snazzy-paprenjak-7e69b9.netlify.app',
      path: '/.netlify/functions/memory-store',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, () => {});
    req.on('error', () => {});
    req.setTimeout(10000, () => req.destroy());
    req.write(body); req.end();
  } catch(e) {}
}
// ── End memory helpers ────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  try {
    const { message, project } = JSON.parse(event.body || '{}');
    if (!message) return { statusCode: 400, body: JSON.stringify({ error: 'No message' }) };

    // Retrieve relevant memories (non-blocking fallback)
    const memories = await fetchMemories(message);
    let memoryContext = '';
    if (memories.length > 0) {
      memoryContext = '\n\nRELEVANT MEMORIES FROM PAST SESSIONS:\n' +
        memories.map((m, i) => `[Memory ${i+1} — ${m.date || 'past'} — ${m.similarity || 0}% match]\n${m.content}`).join('\n\n') +
        '\n\nUse these memories for context. Do not repeat them verbatim.';
    }

    const system = `You are Symbio — Erez Segman's personal AI operating system. Direct, sharp, Hebrew/English bilingual. Act as a trusted senior advisor who knows everything about Erez's world.

Active project: ${project || 'general'}.
User: Erez Segman. Goals: 100K NIS/month across Financia (RE dev, Bat Yam Tama38/2, Herzliya permit), Lotar (CT training, Farm Club, Africa pipeline), Mortgage Advisory (2% fee min 12,500 NIS), AAF (NGO donations), Tax Liens USA (Baltimore 18%+).

RESPONSE RULES (non-negotiable):
- Default: 1-3 sentences MAX. Never longer unless user asks for more.
- Bullet points: 3 words per bullet, max 5 bullets.
- Never repeat what was just said. Never use filler phrases.
- Never start with "Of course", "Great question", "Certainly".
- After giving a short answer: stop. Wait. Let the user lead.
- Language: respond in the SAME language the user used. Mixed He/En → mixed He/En output.${memoryContext}`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: system,
        messages: [{ role: 'user', content: message }]
      })
    });

    const data = await res.json();
    const reply = data.content?.[0]?.text || data.error?.message || 'אין תגובה';

    // Store memory (fire-and-forget)
    storeMemory(message, reply);

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
