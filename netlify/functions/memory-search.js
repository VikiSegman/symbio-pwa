const https = require('https');

function embedText(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: 'text-embedding-3-small', input: text.slice(0, 2000) });
    const req = https.request({
      hostname: 'api.openai.com', path: '/v1/embeddings', method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{ const p=JSON.parse(d); if(p.error) return reject(new Error(p.error.message)); resolve(p.data[0].embedding); }catch(e){reject(e);} }); });
    req.on('error',reject); req.write(body); req.end();
  });
}

function searchMemories(embedding, userId, limit) {
  return new Promise((resolve) => {
    const host = new URL(process.env.SUPABASE_URL).hostname;
    const body = JSON.stringify({ query_embedding: embedding, match_threshold: 0.70, match_count: limit, filter_user_id: userId });
    const req = https.request({
      hostname: host, path: '/rest/v1/rpc/match_memories', method: 'POST',
      headers: { 'apikey': process.env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve(JSON.parse(d));}catch(e){resolve([]);} }); });
    req.on('error',()=>resolve([])); req.write(body); req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Not Allowed' };
  if (!process.env.OPENAI_API_KEY || !process.env.SUPABASE_URL) return { statusCode: 200, body: JSON.stringify({ memories: [] }) };
  try {
    const { query, userId, limit } = JSON.parse(event.body || '{}');
    if (!query) return { statusCode: 200, body: JSON.stringify({ memories: [] }) };
    const embedding = await embedText(query);
    const memories = await searchMemories(embedding, userId || 'erez', Math.min(limit || 5, 10));
    const formatted = (memories || []).map(m => ({ content: m.content, date: m.session_date, similarity: Math.round((m.similarity || 0) * 100) }));
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ memories: formatted }) };
  } catch (error) {
    console.error('[memory-search]', error.message);
    return { statusCode: 200, body: JSON.stringify({ memories: [] }) };
  }
};
