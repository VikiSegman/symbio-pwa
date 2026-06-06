const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const OWNER_ID = process.env.OWNER_CANONICAL_ID || 'erez_segman_1779658339219';

async function isOwner(event) {
  const authz = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const token = authz.startsWith('Bearer ') ? authz.slice(7) : '';
  if (!token) return false;
  try {
    const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON_KEY || SERVICE_KEY, Authorization: `Bearer ${token}` } });
    if (!who.ok) return false;
    const u = await who.json();
    const sid = u && u.id; if (!sid) return false;
    const pr = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?supabase_uid=eq.${encodeURIComponent(sid)}&select=user_id&limit=1`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
    const rows = await pr.json();
    const uid = Array.isArray(rows) && rows[0] && rows[0].user_id;
    return uid === OWNER_ID;
  } catch (_) { return false; }
}

exports.handler = async (event) => {
  if (!(await isOwner(event))) {
    return { statusCode: 200, headers: {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}, body: JSON.stringify({ insights: [] }) };
  }
  try {
    const token2 = process.env.NOTION_TOKEN;
    if (!token2) return { statusCode:200, headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}, body: JSON.stringify({error:'NOTION_TOKEN not set'}) };
    const res = await fetch('https://api.notion.com/v1/databases/c78c819e-11f4-4c01-bc4c-1b0df70e12b2/query', { method: 'POST', headers: { 'Authorization': `Bearer ${token2}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' }, body: JSON.stringify({ page_size: 10, sorts: [{ timestamp: 'created_time', direction: 'descending' }] }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Notion error');
    const insights = (data.results || []).map(p => {
      const props = p.properties || {};
      const titleProp = props.Name || props.Title || props.Insight || props['תובנה'] || Object.values(props).find(v => v.type === 'title');
      const title = titleProp?.title?.map(t => t.plain_text).join('') || 'Untitled';
      const created = p.created_time?.slice(0,10) || '';
      return { title, created, id: p.id };
    }).filter(i => i.title !== 'Untitled');
    return { statusCode: 200, headers: {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}, body: JSON.stringify({ insights }) };
  } catch(e) {
    return { statusCode:200, headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}, body: JSON.stringify({error: e.message}) };
  }
};
