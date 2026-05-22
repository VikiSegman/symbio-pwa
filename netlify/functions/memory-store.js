const https = require('https');

function embedText(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: 'text-embedding-3-small', input: text.slice(0, 8000) });
    const req = https.request({
      hostname: 'api.openai.com', path: '/v1/embeddings', method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{ const p=JSON.parse(d); if(p.error) return reject(new Error(p.error.message)); resolve(p.data[0].embedding); }catch(e){reject(e);} }); });
    req.on('error',reject); req.write(body); req.end();
  });
}

function saveMemory(content, embedding, userId) {
  return new Promise((resolve, reject) => {
    const host = new URL(process.env.SUPABASE_URL).hostname;
    const body = JSON.stringify({ user_id: userId, content, embedding, memory_type: 'conversation', session_date: new Date().toISOString().split('T')[0] });
    const req = https.request({
      hostname: host, path: '/rest/v1/memories', method: 'POST',
      headers: { 'apikey': process.env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Prefer': 'return=minimal' }
    }, (res) => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(res.statusCode)); });
    req.on('error',reject); req.write(body); req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Not Allowed' };
  if (!process.env.OPENAI_API_KEY || !process.env.SUPABASE_URL) return { statusCode: 200, body: JSON.stringify({ stored: false }) };
  try {
    const { userMessage, assistantReply, userId } = JSON.parse(event.body || '{}');
    if (!userMessage || !assistantReply) return { statusCode: 400, body: JSON.stringify({ error: 'Missing messages' }) };
    if (userMessage.length < 5 || assistantReply.length < 10) return { statusCode: 200, body: JSON.stringify({ stored: false, reason: 'Too short' }) };
    const content = `User: ${userMessage}\nSymbio: ${assistantReply}`;
    const embedding = await embedText(content);
    const status = await saveMemory(content, embedding, userId || 'erez');
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stored: true, status }) };
  } catch (error) {
    console.error('[memory-store]', error.message);
    return { statusCode: 200, body: JSON.stringify({ stored: false, error: error.message }) };
  }
};
