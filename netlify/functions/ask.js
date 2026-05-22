const https = require('https');

// ── Embed text via OpenAI ─────────────────────────────────────────────────
function embedText(text) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ model: 'text-embedding-3-small', input: text.slice(0, 4000) });
    const req = https.request({
      hostname: 'api.openai.com', path: '/v1/embeddings', method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d).data?.[0]?.embedding || null); } catch(e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}

// ── Search Supabase for relevant memories ────────────────────────────────
function searchMemories(embedding) {
  return new Promise((resolve) => {
    if (!embedding || !process.env.SUPABASE_URL) return resolve([]);
    const host = new URL(process.env.SUPABASE_URL).hostname;
    const body = JSON.stringify({ query_embedding: embedding, match_threshold: 0.70, match_count: 5, filter_user_id: 'erez' });
    const req = https.request({
      hostname: host, path: '/rest/v1/rpc/match_memories', method: 'POST',
      headers: { 'apikey': process.env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d) || []); } catch(e) { resolve([]); } });
    });
    req.on('error', () => resolve([]));
    req.setTimeout(5000, () => { req.destroy(); resolve([]); });
    req.write(body); req.end();
  });
}

// ── Store memory to Supabase ─────────────────────────────────────────────
function storeMemory(content, embedding) {
  return new Promise((resolve) => {
    if (!embedding || !process.env.SUPABASE_URL) return resolve(false);
    const host = new URL(process.env.SUPABASE_URL).hostname;
    const body = JSON.stringify({ user_id: 'erez', content, embedding, memory_type: 'conversation', session_date: new Date().toISOString().split('T')[0] });
    const req = https.request({
      hostname: host, path: '/rest/v1/memories', method: 'POST',
      headers: { 'apikey': process.env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Prefer': 'return=minimal' }
    }, (res) => { res.on('data', () => {}); res.on('end', () => resolve(res.statusCode === 201)); });
    req.on('error', () => resolve(false));
    req.setTimeout(8000, () => { req.destroy(); resolve(false); });
    req.write(body); req.end();
  });
}

// ── Main handler ─────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  try {
    const { message, project } = JSON.parse(event.body || '{}');
    if (!message) return { statusCode: 400, body: JSON.stringify({ error: 'No message' }) };

    // Step 1: Retrieve relevant memories
    let memoryContext = '';
    try {
      const qEmbed = await embedText(message);
      const memories = await searchMemories(qEmbed);
      if (memories && memories.length > 0) {
        memoryContext = '\n\nRELEVANT MEMORIES FROM PAST SESSIONS:\n' +
          memories.map((m, i) => `[Memory ${i+1} — ${m.session_date || 'past'}]\n${m.content}`).join('\n\n') +
          '\n\nUse these memories for context. Do not repeat them verbatim.';
        console.log(`[ask] ${memories.length} memories retrieved`);
      }
    } catch(e) { console.error('[ask] memory search failed:', e.message); }

    // Step 2: Call Claude
    const system = `You are Symbio — Erez Segman's personal AI operating system. Direct, sharp, Hebrew/English bilingual. Act as a trusted senior advisor who knows everything about Erez's world.

Active project: ${project ||
