// netlify/functions/paypal-webhook.js
// Receives PayPal webhook events and updates Supabase
// Events handled:
// BILLING.SUBSCRIPTION.ACTIVATED - set status=active
// BILLING.SUBSCRIPTION.CANCELLED - set status=cancelled
// BILLING.SUBSCRIPTION.SUSPENDED - set status=suspended
// PAYMENT.SALE.COMPLETED - log payment

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const payload = JSON.parse(event.body);
    const eventType = payload.event_type;
    const resource = payload.resource || {};
    const subscriptionId = resource.id || resource.billing_agreement_id;

    if (!subscriptionId) {
      return { statusCode: 400, body: 'No subscription ID in payload' };
    }

    let updateData = {};

    switch (eventType) {
      case 'BILLING.SUBSCRIPTION.ACTIVATED':
        updateData = { status: 'active', activated_at: new Date().toISOString() };
        break;
      case 'BILLING.SUBSCRIPTION.CANCELLED':
        updateData = { status: 'cancelled', cancelled_at: new Date().toISOString() };
        break;
      case 'BILLING.SUBSCRIPTION.SUSPENDED':
        updateData = { status: 'suspended' };
        break;
      case 'PAYMENT.SALE.COMPLETED':
        updateData = { last_paid_at: new Date().toISOString() };
        break;
      default:
        return { statusCode: 200, body: 'Event ignored' };
    }

    const sbRes = await fetch(
      process.env.SUPABASE_URL + '/rest/v1/subscriptions?subscription_id=eq.' + subscriptionId,
      {
        method: 'PATCH',
        headers: {
          'apikey': process.env.SUPABASE_ANON_KEY,
          'Authorization': 'Bearer ' + process.env.SUPABASE_ANON_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(updateData)
      }
    );

    if (!sbRes.ok) {
      const err = await sbRes.text();
      console.error('Supabase update failed:', err);
      return { statusCode: 500, body: 'DB update failed' };
    }

    return { statusCode: 200, body: JSON.stringify({ received: true, eventType }) };

  } catch (err) {
    console.error('Webhook error:', err);
    return { statusCode: 500, body: err.message };
  }
};
