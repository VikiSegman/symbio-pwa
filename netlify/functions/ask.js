const https = require('https');

// ── helpers ──────────────────────────────────────────────────────────────────

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

async function embedText(text) {
  const r = await httpsPost('api.openai.com', '/v1/embeddings',
    { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
    { model: 'text-embedding-3-small', input: text.slice(0, 4000) }
  );
  if (r.body.error) throw new Error(r.body.error.message);
  return r.body.data[0].embedding;
}

async function searchMemories(query, userId) {
  try {
    const embedding = await embedText(query);
    const host = new URL(process.env.SUPABASE_URL).hostname;
    const r = await httpsPost(host, '/rest/v1/rpc/match_memories',
      { 'apikey': process.env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}` },
      { query_embedding: embedding, match_threshold: 0.72, match_count: 4, filter_user_id: userId }
    );
    return (Array.isArray(r.body) ? r.body : [])
      .map(m => `[${m.session_date || 'past'}] ${m.content}`);
  } catch(e) {
    console.error('[memory-search]', e.message);
    return [];
  }
}

async function storeMemory(userMessage, assistantReply, userId) {
  try {
    if (userMessage.length < 5 || assistantReply.length < 10) return;
    const content = `User: ${userMessage}\nSymbio: ${assistantReply}`;
    const embedding = await embedText(content);
    const host = new URL(process.env.SUPABASE_URL).hostname;
    await httpsPost(host, '/rest/v1/memories',
      { 'apikey': process.env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`, 'Prefer': 'return=minimal' },
      { user_id: userId, content, embedding, memory_type: 'conversation', session_date: new Date().toISOString().split('T')[0] }
    );
  } catch(e) {
    console.error('[memory-store]', e.message);
  }
}

// ── handler ───────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  try {
    const { message, project, uid } = JSON.parse(event.body || '{}');
    if (!message) return { statusCode: 400, body: JSON.stringify({ error: 'No message' }) };

    const ownerUID = (process.env.OWNER_UID || '').trim();
    const isOwner  = ownerUID.length > 0 && uid === ownerUID;
    const userId   = isOwner ? 'erez' : (uid || 'guest');

    const platformRules = `RESPONSE STYLE (non-negotiable):
- Default: 1-3 sentences MAX. Never longer unless user asks "explain more" or "expand".
- If listing items: bullet points, 3 words per bullet, max 5 bullets.
- Never repeat what was just said. Never add filler phrases.
- Never start with "Of course", "Great question", "Certainly" or similar.
- After giving a short answer: stop. Wait. Let the user lead.
- Language: respond in the SAME language the user used. Mixed He/En → mixed He/En.
`;

    // ── for owner: search memory + build rich context in parallel ──
    let memoryBlock = '';
    let userContext = '';

    if (isOwner) {
      const memories = await searchMemories(message, userId);
      if (memories.length > 0) {
        memoryBlock = `\n\nRELEVANT PAST CONTEXT (from your memory):\n${memories.join('\n---\n')}\n`;
      }

      userContext = `You are Symbio – Erez Segman's personal AI operating system.
Active project: ${project || 'general'}.
Goals: 100K NIS/month across Financia (RE dev+fund, Bat Yam + Herzliya תמ"א projects), Lotar (CT training + farm club), Mortgage Advisory (2% fee min 12,500 NIS), AAF (NGO donations), Tax Liens USA (18%+ annual yield).
Always prioritize cash flow, lead generation, and deal closure.${memoryBlock}`;
    } else {
      userContext = 'You are Symbio – a helpful AI assistant. Answer concisely and helpfully.';
    }

    const system = platformRules + '\n' + userContext;

    // ── call Claude ──
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 400,
        system,
        messages: [{ role: 'user', content: message }]
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `API error ${res.status}`);

    const reply = data.content[0].text;

    // ── parallel: memory store + ambient entity extraction ──
    let finalReply = reply;

    if (isOwner) {
      // Memory store — fire and forget
      storeMemory(message, reply, userId).catch(() => {});

      // Ambient extraction — wait for result to append confirmation
      try {
        const extractRes = await Promise.race([
          fetch(
          `${process.env.URL || 'https://snazzy-paprenjak-7e69b9.netlify.app'}/.netlify/functions/extract`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userMessage: message, assistantReply: reply, uid })
          }
        ),
          new Promise((_, rej) => setTimeout(() => rej(new Error('extract timeout')), 3000))
        ]);
        if (extractRes.ok) {
          const extractData = await extractRes.json();
          if (extractData.confirmation) {
            finalReply = reply + extractData.confirmation;
          }
        }
      } catch(e) {
        // Extraction failure never breaks the response
        console.error('[ask/extract]', e.message);
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ reply: finalReply })
    };

  } catch(e) {
    console.error('[ask]', e.message);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: e.message, reply: 'שגיאה: ' + e.message })
    };
  }
};
