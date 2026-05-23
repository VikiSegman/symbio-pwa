const https = require('https');

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve) => {
    const req = https.request(
      { hostname, path, method: 'POST', headers },
      (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
          catch(e) { resolve({ status: res.statusCode, body: {} }); }
        });
      }
    );
    req.on('error', () => resolve({ status: 500, body: {} }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ status: 408, body: {} }); });
    req.write(body);
    req.end();
  });
}

async function getEmbedding(text) {
  const body = JSON.stringify({ model: 'text-embedding-3-small', input: text.slice(0, 4000) });
  const r = await httpsPost('api.openai.com', '/v1/embeddings', {
    'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body)
  }, body);
  return r.body.data?.[0]?.embedding || null;
}

async function searchMemories(embedding) {
  if (!embedding || !process.env.SUPABASE_URL) return [];
  const host = new URL(process.env.SUPABASE_URL).hostname;
  const body = JSON.stringify({
    query_embedding: embedding,
    match_threshold: 0.70,
    match_count: 5,
    filter_user_id: 'erez'
  });
  const r = await httpsPost(host, '/rest/v1/rpc/match_memories', {
    'apikey': process.env.SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body)
  }, body);
  return Array.isArray(r.body) ? r.body : [];
}

async function saveMemory(content, embedding) {
  if (!process.env.SUPABASE_URL) { console.error('[ask] no SUPABASE_URL'); return false; }
  const host = new URL(process.env.SUPABASE_URL).hostname;
  // Send without embedding first to test basic insert
  const payload = {
    user_id: 'erez',
    content: content,
    memory_type: 'conversation',
    session_date: new Date().toISOString().split('T')[0]
  };
  if (embedding) payload.embedding = embedding;
  const body = JSON.stringify(payload);
  const r = await httpsPost(host, '/rest/v1/memories', {
    'apikey': process.env.SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Prefer': 'return=minimal'
  }, body);
  console.log('[ask] supabase status:', r.status, 'body:', JSON.stringify(r.body).slice(0, 200));
  return r.status === 201;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  try {
    const { message, project } = JSON.parse(event.body || '{}');
    if (!message) return { statusCode: 400, body: JSON.stringify({ error: 'No message' }) };

    // Step 1: Search memories
    let memoryContext = '';
    try {
      const qEmbed = await getEmbedding(message);
      const memories = await searchMemories(qEmbed);
      if (memories.length > 0) {
        memoryContext = '\n\nזיכרונות רלוונטיים משיחות קודמות:\n' +
          memories.map((m, i) =>
            `[זיכרון ${i+1} — ${m.session_date || 'עבר'}]\n${m.content}`
          ).join('\n\n') +
          '\n\nהשתמש בזיכרונות אלה להקשר. אל תחזור עליהם מילה במילה.';
        console.log('[ask] memories found:', memories.length);
      }
    } catch(e) {
      console.error('[ask] memory search failed:', e.message);
    }

    // Step 2: Call Claude
    const system = `אתה סימביו — מערכת ה-AI האישית של ארז סגמן (Erez Segman).
ישיר, חד, דו-לשוני עברית/אנגלית. פעל כיועץ בכיר מהימן שמכיר את כל עולמו של ארז.

פרויקט פעיל: ${project || 'כללי'}.
מטרות: 100K ש"ח/חודש — Financia (פיתוח נדל"ן, בת ים תמא 38/2, הרצליה), Lotar (הדרכת מ"א, חוות לוטר, אפריקה), ייעוץ משכנתאות (2% מינ׳ 12,500 ש"ח), AAF (תרומות), Tax Liens ארה"ב (Baltimore 18%+).

כללי תגובה (לא ניתנים לשינוי):
- ברירת מחדל: 1-3 משפטים בלבד. לא יותר אלא אם נשאל.
- רשימות: 3 מילות לנקודה, מקסימום 5 נקודות.
- לעולם אל תחזור על מה שנאמר. אל תוסיף ביטויי מילוי.
- לעולם אל תתחיל ב"כמובן", "שאלה מצוינת", "בוודאי".
- שפה: ענה באותה שפה שבה השתמש המשתמש.${memoryContext}`;

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
        system,
        messages: [{ role: 'user', content: message }]
      })
    });

    const data = await res.json();
    const reply = data.content?.[0]?.text || data.error?.message || 'אין תגובה';
    console.log('[ask] reply length:', reply.length);

    // Step 3: Store memory BEFORE returning (Netlify kills process after return)
    try {
      const content = `User: ${message}\nSymbio: ${reply}`;
      const embedding = await getEmbedding(content);
      const stored = await saveMemory(content, embedding);
      console.log('[ask] memory stored:', stored);
    } catch(e) {
      console.error('[ask] memory store failed:', e.message);
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reply })
    };

  } catch (error) {
    console.error('[ask] handler error:', error.message);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
