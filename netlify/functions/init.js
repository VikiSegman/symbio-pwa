const https = require('https');

function verifySupabaseToken(token) {
  return new Promise((resolve) => {
    try {
      const host = new URL(process.env.SUPABASE_URL).hostname;
      const req = https.request({
        hostname: host,
        path: '/auth/v1/user',
        method: 'GET',
        headers: {
          'apikey': process.env.SUPABASE_ANON_KEY,
          'Authorization': 'Bearer ' + token
        }
      }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try { resolve(JSON.parse(d)); } catch(e) { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.end();
    } catch(e) { resolve(null); }
  });
}

exports.handler = async (event) => {
  const cors = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  try {
    const body = JSON.parse(event.body || '{}');
    const ownerUID = (process.env.OWNER_UID || '').trim();
    const ownerEmail = (process.env.OWNER_EMAIL || 'erez.financia@gmail.com').trim().toLowerCase();

    // Path 1: check by symbio_uid (existing flow)
    if (body.uid) {
      const isOwner = ownerUID.length > 0 && body.uid === ownerUID;
      return { statusCode: 200, headers: cors, body: JSON.stringify({ isOwner }) };
    }

    // Path 2: check by Supabase access token (post-OAuth flow)
    if (body.supabaseToken) {
      const userData = await verifySupabaseToken(body.supabaseToken);
      if (userData && userData.email) {
        const isOwner = userData.email.toLowerCase() === ownerEmail;
        // Return ownerUID so the frontend can store it
        return { statusCode: 200, headers: cors,
          body: JSON.stringify({ isOwner, ownerUID: isOwner ? ownerUID : null }) };
      }
    }

    return { statusCode: 200, headers: cors, body: JSON.stringify({ isOwner: false }) };
  } catch(e) {
    return { statusCode: 200, headers: cors, body: JSON.stringify({ isOwner: false }) };
  }
};
