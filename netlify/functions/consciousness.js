exports.handler = async (event) => {
  const ownerUID = (process.env.OWNER_UID || '').trim();
  const uid = (event.queryStringParameters || {}).uid || '';
  if (!ownerUID || uid !== ownerUID) {
    return { statusCode: 200,
      headers: {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'},
      body: JSON.stringify({ lines: [] }) };
  }
  try {
    const token = process.env.NOTION_TOKEN;
    if (!token) return { statusCode:200, headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}, body: JSON.stringify({error:'NOTION_TOKEN not set'}) };

    // Get page blocks
    const res = await fetch('https://api.notion.com/v1/blocks/35db1191-5d41-81d5-a860-f409e6ad6a7b/children?page_size=20', {
      headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28' }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Notion error');

    // Extract text from blocks
    const lines = [];
    (data.results || []).forEach(b => {
      const texts = b[b.type]?.rich_text || [];
      const text = texts.map(t => t.plain_text).join('').trim();
      if (text && text.length > 0 && lines.length < 18) lines.push(text);
    });

    return {
      statusCode: 200,
      headers: {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'},
      body: JSON.stringify({ lines })
    };
  } catch(e) {
    return { statusCode:200, headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}, body: JSON.stringify({error: e.message}) };
  }
};