// netlify/functions/paypal-verify.js
// Called by frontend after user approves PayPal subscription
// Verifies with PayPal API then updates Supabase then returns plan tier

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { subscriptionId, userId } = JSON.parse(event.body);
    if (!subscriptionId || !userId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing subscriptionId or userId' }) };
    }

    const authRes = await fetch('https://api-m.paypal.com/v1/oauth2/token', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(
          process.env.PAYPAL_CLIENT_ID + ':' + process.env.PAYPAL_CLIENT_SECRET
        ).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    });
    const { access_token } = await authRes.json();

    const subRes = await fetch('https://api-m.paypal.com/v1/billing/subscriptions/' + subscriptionId, {
      headers: { 'Authorization': 'Bearer ' + access_token }
    });
    const sub = await subRes.json();

    if (sub.status !== 'ACTIVE') {
      return { statusCode: 400, body: JSON.stringify({ error: 'Subscription not active', status: sub.status }) };
    }

    const planId = sub.plan_id;
    let tier = 'starter';
    if (planId === process.env.PAYPAL_PLAN_PERSONAL) tier = 'personal';
    if (planId === process.env.PAYPAL_PLAN_PRO) tier = 'pro';

    const sbRes = await fetch(process.env.SUPABASE_URL + '/rest/v1/subscriptions', {
      method: 'POST',
      headers: {
        'apikey': process.env.SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + process.env.SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({
        user_id: userId,
        subscription_id: subscriptionId,
        plan_id: planId,
        tier: tier,
        status: 'active',
        activated_at: new Date().toISOString(),
        next_billing: sub.billing_info && sub.billing_info.next_billing_time || null
      })
    });

    if (!sbRes.ok) {
      const err = await sbRes.text();
      return { statusCode: 500, body: JSON.stringify({ error: 'Supabase save failed', detail: err }) };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, tier, subscriptionId })
    };

  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
