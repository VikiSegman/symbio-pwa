// netlify/functions/paypal-verify.js — SECURITY-HARDENED 2026-06-06
// Entitlement is bound to the AUTHENTICATED caller (Bearer token), not a client field.
// Rejects re-use of one subscription across accounts. Syncs tier to user_profiles.
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SVC  =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SECRET_KEY;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')   return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };

  try {
    // 1) Authenticate the caller — bind entitlement to the logged-in user, never a client field
    const token = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Not authenticated' }) };

    const uRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` } });
    const u = await uRes.json();
    if (!u || !u.id) return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Invalid session' }) };

    const pRes = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?supabase_uid=eq.${u.id}&select=user_id`,
      { headers: { apikey: SUPABASE_SVC, Authorization: `Bearer ${SUPABASE_SVC}` } });
    const prof = (await pRes.json())[0];
    const userId = prof && prof.user_id;
    if (!userId) return { statusCode: 403, headers: cors, body: JSON.stringify({ error: 'No profile for this account' }) };

    // 2) Input
    const { subscriptionId } = JSON.parse(event.body || '{}');
    if (!subscriptionId) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing subscriptionId' }) };

    // 3) Verify with PayPal (tier derived server-side from plan_id, never the client)
    const authRes = await fetch('https://api-m.paypal.com/v1/oauth2/token', {
      method: 'POST',
      headers: { 'Authorization': 'Basic ' + Buffer.from(process.env.PAYPAL_CLIENT_ID + ':' + process.env.PAYPAL_CLIENT_SECRET).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials'
    });
    const { access_token } = await authRes.json();
    const subRes = await fetch('https://api-m.paypal.com/v1/billing/subscriptions/' + encodeURIComponent(subscriptionId), { headers: { 'Authorization': 'Bearer ' + access_token } });
    const sub = await subRes.json();
    if (sub.status !== 'ACTIVE') return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Subscription not active', status: sub.status }) };

    const planId = sub.plan_id;
    let tier = 'starter';
    if (planId === process.env.PAYPAL_PLAN_PERSONAL) tier = 'personal';
    if (planId === process.env.PAYPAL_PLAN_PRO) tier = 'pro';

    // 4) Anti-replay: a subscription cannot be claimed by a different account
    const existRes = await fetch(`${SUPABASE_URL}/rest/v1/subscriptions?subscription_id=eq.${encodeURIComponent(subscriptionId)}&select=user_id`,
      { headers: { apikey: SUPABASE_SVC, Authorization: `Bearer ${SUPABASE_SVC}` } });
    const existing = await existRes.json();
    if (Array.isArray(existing) && existing.some(r => r.user_id && r.user_id !== userId))
      return { statusCode: 409, headers: cors, body: JSON.stringify({ error: 'Subscription already linked to another account' }) };

    // 5) Persist via service key (after identity proven)
    const sbRes = await fetch(`${SUPABASE_URL}/rest/v1/subscriptions`, {
      method: 'POST',
      headers: { apikey: SUPABASE_SVC, Authorization: `Bearer ${SUPABASE_SVC}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ user_id: userId, subscription_id: subscriptionId, plan_id: planId, tier, status: 'active', activated_at: new Date().toISOString(), next_billing: (sub.billing_info && sub.billing_info.next_billing_time) || null })
    });
    if (!sbRes.ok) {
      const err = await sbRes.text();
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Supabase save failed', detail: err }) };
    }

    // 6) Sync tier to profile so the upgrade takes effect at login
    await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?user_id=eq.${encodeURIComponent(userId)}`, {
      method: 'PATCH',
      headers: { apikey: SUPABASE_SVC, Authorization: `Bearer ${SUPABASE_SVC}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ tier })
    }).catch(() => {});

    return { statusCode: 200, headers: cors, body: JSON.stringify({ success: true, tier, subscriptionId }) };
  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};
