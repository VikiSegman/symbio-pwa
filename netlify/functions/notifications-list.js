// netlify/functions/notifications-list.js
// SYMBIO in-app inbox reader. Returns a user's notifications (REAL only), newest first.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;

exports.handler = async (event) => {
  try {
    if (!SUPABASE_URL || !SERVICE_KEY) return json(500, { error: 'Supabase env missing' });
    let body = {}; try { body = JSON.parse(event.body || '{}'); } catch (_) {}
    const uid = body.uid;
    if (!uid) return json(400, { error: 'uid required' });
    // is_synthetic=eq.false => synthetic notifications never appear in a real inbox (defense-in-depth)
    const r = await fetch(`${SUPABASE_URL}/rest/v1/notifications?user_id=eq.${encodeURIComponent(uid)}&is_synthetic=eq.false&select=id,faculty,title,body,read_at,created_at&order=created_at.desc&limit=50`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const rows = await r.json();
    if (!r.ok) return json(500, { error: 'db', detail: rows });
    return json(200, { notifications: rows, unread: (rows || []).filter(n => !n.read_at).length });
  } catch (e) { return json(500, { error: String(e).slice(0, 200) }); }
};
function json(s, o) { return { statusCode: s, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) }; }
