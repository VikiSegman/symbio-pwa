const https = require('https');

function supabaseRequest(method, path, body) {
  return new Promise((resolve) => {
    if (!process.env.SUPABASE_URL) return resolve({ status: 500, body: {} });
    const host = new URL(process.env.SUPABASE_URL).hostname;
    const bodyStr = body ? JSON.stringify(body) : '';
    const req = https.request({
      hostname: host, path, method,
      headers: {
        'apikey': process.env.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
        ...(bodyStr && { 'Content-Length': Buffer.byteLength(bodyStr) })
      }
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d || '[]') }); }
        catch(e) { resolve({ status: res.statusCode, body: [] }); }
      });
    });
    req.on('error', () => resolve({ status: 500, body: [] }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ status: 408, body: [] }); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Not Allowed' };

  try {
    const { action, userId, name, data } = JSON.parse(event.body || '{}');
    const uid = userId || 'erez';

    // GET — fetch all people or search by name
    if (action === 'get') {
      const nameFilter = name ? `&name=ilike.*${encodeURIComponent(name)}*` : '';
      const r = await supabaseRequest('GET',
        `/rest/v1/people?user_id=eq.${uid}&order=updated_at.desc${nameFilter}`, null);
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ people: r.body }) };
    }

    // UPSERT — create or update person
    if (action === 'upsert' && name) {
      const check = await supabaseRequest('GET',
        `/rest/v1/people?user_id=eq.${uid}&name=ilike.*${encodeURIComponent(name)}*&limit=1`, null);
      const existing = Array.isArray(check.body) ? check.body[0] : null;

      if (existing) {
        const updates = { ...data, updated_at: new Date().toISOString() };
        if (data.notes && existing.notes && !existing.notes.includes(data.notes)) {
          updates.notes = existing.notes + '\n' + data.notes;
        }
        const r = await supabaseRequest('PATCH',
          `/rest/v1/people?id=eq.${existing.id}`, updates);
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'updated', person: r.body }) };
      } else {
        const r = await supabaseRequest('POST', '/rest/v1/people',
          { user_id: uid, name, ...data });
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'created', person: r.body }) };
      }
    }

    // STALE — people not contacted recently
    if (action === 'stale') {
      const r = await supabaseRequest('GET',
        `/rest/v1/people?user_id=eq.${uid}&last_contact=not.is.null&order=last_contact.asc&limit=5`, null);
      const stale = (r.body || []).filter(p => {
        if (!p.last_contact || !p.contact_frequency_days) return false;
        const daysSince = Math.floor((Date.now() - new Date(p.last_contact)) / 86400000);
        return daysSince > p.contact_frequency_days;
      });
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stale }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action' }) };

  } catch (error) {
    console.error('[social-graph] error:', error.message);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
