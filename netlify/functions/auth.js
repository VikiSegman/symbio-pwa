// netlify/functions/auth.js
// Handles signup, login, logout
// user_id = firstname_lastname (+ country_city if duplicate)

const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_ANON   = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SVCKEY = process.env.SUPABASE_SERVICE_KEY;

// ── helpers ────────────────────────────────────────────────────────────────────

function buildUserId(firstName, lastName, country = '', city = '') {
  const base = `${firstName}_${lastName}`
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
  if (!country && !city) return base;
  const suffix = `${country}_${city}`
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
  return `${base}_${suffix}`;
}

async function userIdExists(userId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/user_profiles?user_id=eq.${userId}&select=user_id`,
    { headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}` } }
  );
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

async function sbPost(path, body, useServiceKey = false) {
  const key = useServiceKey ? SUPABASE_SVCKEY : SUPABASE_ANON;
  return fetch(`${SUPABASE_URL}${path}`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
}

// ── main handler ───────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: 'Method Not Allowed' };
  }

  try {
    const { action, email, password, firstName, lastName, country, city } = JSON.parse(event.body);

    // ── SIGNUP ──────────────────────────────────────────────────────────────────
    if (action === 'signup') {
      if (!email || !password || !firstName || !lastName) {
        return { statusCode: 400, headers: corsHeaders,
          body: JSON.stringify({ error: 'email, password, firstName, lastName required' }) };
      }

      // 1. Create Supabase Auth user
      const authRes = await sbPost('/auth/v1/signup', { email, password });
      const authData = await authRes.json();

      if (authData.error || authData.error_description) {
        return { statusCode: 400, headers: corsHeaders,
          body: JSON.stringify({ error: authData.error_description || authData.error?.message || authData.error || 'Signup failed' }) };
      }

      const supabaseUid = authData.user?.id;
      if (!supabaseUid) {
        return { statusCode: 500, headers: corsHeaders,
          body: JSON.stringify({ error: 'Auth user creation failed — no UID returned' }) };
      }

      // 2. Generate unique user_id from name
      const userId = await resolveUniqueUserId(firstName, lastName, country || '', city || '');

      // 3. Save profile
      await fetch(`${SUPABASE_URL}/rest/v1/user_profiles`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_ANON,
          Authorization: `Bearer ${SUPABASE_ANON}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal'
        },
        body: JSON.stringify({
          supabase_uid: supabaseUid,
          user_id: userId,
          first_name: firstName,
          last_name: lastName,
          email,
          country: country || '',
          city: city || '',
          tier: 'starter',
          created_at: new Date().toISOString()
        })
      });

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          success: true,
          userId,
          firstName,
          tier: 'starter',
          supabaseUid,
          session: authData.session
        })
      };
    }

    // ── LOGIN ───────────────────────────────────────────────────────────────────
    if (action === 'login') {
      if (!email || !password) {
        return { statusCode: 400, headers: corsHeaders,
          body: JSON.stringify({ error: 'email and password required' }) };
      }

      const authRes = await sbPost('/auth/v1/token?grant_type=password', { email, password });
      const authData = await authRes.json();

      // Handle all Supabase error formats
      if (authData.error || authData.error_description || !authData.access_token) {
        return { statusCode: 401, headers: corsHeaders,
          body: JSON.stringify({ error: 'Invalid email or password' }) };
      }

      // Get user info via /auth/v1/user (more reliable than authData.user)
      const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${authData.access_token}` }
      });
      const userData = await userRes.json();

      if (!userData || !userData.id) {
        return { statusCode: 401, headers: corsHeaders,
          body: JSON.stringify({ error: 'Could not retrieve user info' }) };
      }

      // Fetch profile for user_id and tier
      const profileRes = await fetch(
        `${SUPABASE_URL}/rest/v1/user_profiles?supabase_uid=eq.${userData.id}&select=user_id,tier,first_name`,
        { headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${authData.access_token}` } }
      );
      const profiles = await profileRes.json();
      const profile = profiles[0] || {};

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          success: true,
          userId: profile.user_id || userData.email,
          firstName: profile.first_name || '',
          tier: profile.tier || 'starter',
          session: authData
        })
      };
    }

    // ── LOGOUT ──────────────────────────────────────────────────────────────────
    if (action === 'logout') {
      return { statusCode: 200, headers: corsHeaders,
        body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 400, headers: corsHeaders,
      body: JSON.stringify({ error: 'Unknown action' }) };

  } catch (err) {
    return { statusCode: 500, headers: corsHeaders,
      body: JSON.stringify({ error: err.message }) };
  }
};
