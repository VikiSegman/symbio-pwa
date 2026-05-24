// whatsapp.js — Symbio WhatsApp Business Webhook
// Receives incoming messages → extracts leads/contacts → saves to Master CRM
// Setup: Meta Business → WhatsApp → Webhook URL: /api/v1/.netlify/functions/whatsapp
// Env vars needed: WHATSAPP_VERIFY_TOKEN, WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_ID

const NOTION_VERSION = '2022-06-28';
const MASTER_CRM     = '65013e2e-2627-4a71-ac3b-bd212f5671e3';

// ── WhatsApp API helper ───────────────────────────────────────────────────────
async function sendWhatsApp(to, text) {
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  const token   = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!phoneId || !token) return;
  await fetch(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } })
  });
}

// ── Claude entity extraction ──────────────────────────────────────────────────
async function extractFromWhatsApp(from, message, apiKey) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5', max_tokens: 300,
      messages: [{ role: 'user', content: `
WhatsApp message from ${from}:
"${message}"

Is this a business inquiry? Return JSON only:
{
  "is_lead": true/false,
  "name": "sender name if mentioned or null",
  "project": "Lotar|Mortgage|Financia|AAF|Tax Liens|Other",
  "interest": "what they want in 1 sentence",
  "stage": "חדש",
  "temperature": "hot|warm|cold",
  "confidence": 0.0-1.0,
  "reply": "brief friendly Hebrew/English reply acknowledging receipt, 1 sentence"
}` }]
    })
  });
  if (!r.ok) return null;
  const d = await r.json();
  try { return JSON.parse(d.content[0].text.replace(/```json|```/g,'').trim()); }
  catch(e) { return null; }
}

// ── Save lead to Master CRM ───────────────────────────────────────────────────
async function saveLead(from, extracted, message, notionToken) {
  const name = extracted.name || `WhatsApp ${from}`;
  await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${notionToken}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      parent: { database_id: MASTER_CRM },
      properties: {
        'Name':        { title: [{ text: { content: name } }] },
        'Stage':       { select: { name: 'חדש' } },
        'Project':     { select: { name: extracted.project || 'Other' } },
        'Source':      { select: { name: 'WhatsApp' } },
        'Temperature': { select: { name: extracted.temperature === 'hot' ? '🔴 רותח' : extracted.temperature === 'warm' ? '🟠 חם' : '🔵 קר' } },
        'WhatsApp':    { phone_number: from },
        'Notes':       { rich_text: [{ text: { content: `[WhatsApp] ${extracted.interest || message.slice(0,200)}` } }] }
      }
    })
  });
}

// ── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  // Webhook verification (GET)
  if (event.httpMethod === 'GET') {
    const params = event.queryStringParameters || {};
    if (params['hub.verify_token'] === process.env.WHATSAPP_VERIFY_TOKEN) {
      return { statusCode: 200, body: params['hub.challenge'] };
    }
    return { statusCode: 403, body: 'Invalid verify token' };
  }

  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  try {
    const body = JSON.parse(event.body || '{}');

    // Extract message from WhatsApp webhook payload
    const entry   = body.entry?.[0];
    const change  = entry?.changes?.[0]?.value;
    const msg     = change?.messages?.[0];
    if (!msg || msg.type !== 'text') return { statusCode: 200, body: 'ok' };

    const from    = msg.from;           // phone number
    const text    = msg.text?.body || '';
    const apiKey  = process.env.ANTHROPIC_API_KEY;
    const nToken  = process.env.NOTION_TOKEN;

    if (!text || !apiKey || !nToken) return { statusCode: 200, body: 'ok' };

    // Always log the raw message to CRM regardless of extraction
    // Then try to classify
    const extracted = await extractFromWhatsApp(from, text, apiKey);

    if (extracted && extracted.is_lead && extracted.confidence >= 0.6) {
      // Save to CRM
      await saveLead(from, extracted, text, nToken);

      // Auto-reply
      const replyText = extracted.reply ||
        `תודה! קיבלתי את הפנייה שלך. נחזור אליך בהקדם. 🛡️ Lotar`;
      await sendWhatsApp(from, replyText);
    } else if (text.length > 5) {
      // Log non-lead messages too (contacts, questions, etc.)
      await fetch('https://api.notion.com/v1/pages', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${nToken}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parent: { database_id: MASTER_CRM },
          properties: {
            'Name':    { title: [{ text: { content: `WA ${from} — ${new Date().toISOString().split('T')[0]}` } }] },
            'Stage':   { select: { name: 'חדש' } },
            'Source':  { select: { name: 'WhatsApp' } },
            'WhatsApp':{ phone_number: from },
            'Notes':   { rich_text: [{ text: { content: text.slice(0, 500) } }] }
          }
        })
      });
    }

    return { statusCode: 200, body: 'ok' };
  } catch(e) {
    console.error('[whatsapp]', e.message);
    return { statusCode: 200, body: 'ok' }; // Always return 200 to Meta
  }
};
