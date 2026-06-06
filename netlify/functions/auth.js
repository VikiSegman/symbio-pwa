// netlify/functions/auth.js — SECURITY-HARDENED 2026-06-06
// signup / login / logout. user_id = firstname_lastname (+country_city if dup)
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY;
// FIX: real service var on this project is SUPABASE_SERVICE_ROLE_KEY (old code used SUPABASE_SERVICE_KEY = undefined)
const SUPABASE_SVCKEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SECRET_KEY;

const CONSENT_VERSION = 'privacy_v1';
async function sbServiceInsert(table, row) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_SVCKEY, Authorization: `Bearer ${SUPABASE_SVCKEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(row)
    });
  } catch (e) {}
}
async function logConsent(userId, granted) {
  await sbServiceInsert('consent_log', { user_id: userId, consent_type: 'signup_privacy', consent_version: CONSENT_VERSION, granted: !!granted });
}
async function audit(actor, action, resource, detail) {
  await sbServiceInsert('audit_log', { actor, action, resource: resource || null, detail: detail || null });
}

function buildUserId(firstName, lastName, country = '', city = '') {
  const base = `${firstName}_${lastName}`.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
  if (!country && !city) return base;
  const suffix = `${country}_${city}`.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
  return `${base}_${suffix}`;
}
// FIX: uniqueness check via SERVICE key (reliable regardless of anon RLS)
async function userIdExists(userId) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?user_id=eq.${userId}&select=user_id`,
    { headers: { apikey: SUPABASE_SVCKEY, Authorization: `Bearer ${SUPABASE_SVCKEY}` } });
  const rows = await res.json();
  return Array.isArray(rows) && rows.length > 0;
}
async function resolveUniqueUserId(firstName, lastName, country, city) {
  const base = buildUserId(firstName, lastName);
  if (!(await userIdExists(base))) return base;
  const withLocation = buildUserId(firstName, lastName, country, city);
  if (!(await userIdExists(withLocation))) return withLocation;
  return `${withLocation}_${Date.now()}`;
}
async function sbPost(path, body) { // auth endpoints require the anon key
  return fetch(`${SUPABASE_URL}${path}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*', // OPTIONAL hardening: set to 'https://symbio-app.netlify.app'
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST')   return { statusCode: 405, headers: corsHeaders, body: 'Method Not Allowed' };

  try {
    const { action, email, password, firstName, lastName, country, city, consent } = JSON.parse(event.body);

    if (action === 'signup') {
      if (!email || !password || !firstName || !lastName)
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'email, password, firstName, lastName required' }) };

      const authRes = await sbPost('/auth/v1/signup', { email, password });
      const authData = await authRes.json();
      if (authData.error || authData.error_description)
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: authData.error_description || authData.error?.message || authData.error || 'Signup failed' }) };

      const supabaseUid = authData.user?.id;
      if (!supabaseUid)
        return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Auth user creation failed — no UID returned' }) };

      const userId = await resolveUniqueUserId(firstName, lastName, country || '', city || '');

      // FIX: profile insert via SERVICE key, and error is surfaced (no silent half-created accounts)
      const profRes = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles`, {
        method: 'POST',
        headers: { apikey: SUPABASE_SVCKEY, Authorization: `Bearer ${SUPABASE_SVCKEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({
          supabase_uid: supabaseUid, user_id: userId,
          first_name: firstName, last_name: lastName, email,
          country: country || '', city: city || '',
          tier: 'starter', created_at: new Date().toISOString()
        })
      });
      if (!profRes.ok) {
        const detail = await profRes.text();
        return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Profile creation failed', detail }) };
      }

      await Promise.all([
        logConsent(userId, consent !== false),
        audit(userId, 'signup', 'user_profiles', null),
        audit(userId, 'consent_granted', 'consent_log', CONSENT_VERSION)
      ]).catch(() => {});

      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ success: true, userId, firstName, tier: 'starter', supabaseUid, session: authData.session }) };
    }

    if (action === 'login') {
      if (!email || !password)
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'email and password required' }) };

      const authRes = await sbPost('/auth/v1/token?grant_type=password', { email, password });
      const authData = await authRes.json();
      if (authData.error || authData.error_description || !authData.access_token)
        return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid email or password' }) };

      const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${authData.access_token}` } });
      const userData = await userRes.json();
      if (!userData || !userData.id)
        return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'Could not retrieve user info' }) };

      // FIX: token already verified above; fetch profile via SERVICE key (anon-RLS-independent)
      const profileRes = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?supabase_uid=eq.${userData.id}&select=user_id,tier,first_name`,
        { headers: { apikey: SUPABASE_SVCKEY, Authorization: `Bearer ${SUPABASE_SVCKEY}` } });
      const profiles = await profileRes.json();
      const profile = profiles[0] || {};
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ success: true, userId: profile.user_id || userData.email, firstName: profile.first_name || '', tier: profile.tier || 'starter', session: authData }) };
    }

    if (action === 'logout')
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ success: true }) };

    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Unknown action' }) };
  } catch (err) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: err.message }) };
  }
};
