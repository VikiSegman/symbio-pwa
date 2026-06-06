const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;

async function verifyOwner(event) {
  const ownerUID = (process.env.OWNER_UID || '').trim();
  const authz = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const token = authz.startsWith('Bearer ') ? authz.slice(7) : '';
  if (!token || !ownerUID) return false;
  try {
    const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: ANON_KEY || SERVICE_KEY, Authorization: `Bearer ${token}` }
    });
    if (!who.ok) return false;
    const u = await who.json();
    return !!(u && u.id) && u.id === ownerUID;
  } catch (_) { return false; }
}

exports.handler = async (event) => {
  if (!(await verifyOwner(event))) {
    return { statusCode: 200, headers: {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}, body: JSON.stringify({ lines: [] }) };
  }
  try {
    const token2 = process.env.NOTION_TOKEN;
    if (!token2) return { statusCode:200, headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}, body: JSON.stringify({error:'NOTION_TOKEN not set'}) };
    const res = await fetch('https://api.notion.com/v1/blocks/35db1191-5d41-81d5-a860-f409e6ad6a7b/children?page_size=20', {
      headers: { 'Authorization': `Bearer ${token2}`, 'Notion-Version': '2022-06-28' }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Notion error');
    const lines = [];
    (data.results || []).forEach(b => {
      const texts = b[b.type]?.rich_text || [];
      const text = texts.map(t => t.plain_text).join('').trim();
      if (text && text.length > 0 && lines.length < 18) lines.push(text);
    });
    return { statusCode: 200, headers: {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}, body: JSON.stringify({ lines }) };
  } catch(e) {
    return { statusCode:200, headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}, body: JSON.stringify({error: e.message}) };
  }
};
