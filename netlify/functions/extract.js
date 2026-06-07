// extract.js — Symbio Ambient Entity Extractor
// Detects deals, contacts, decisions from any conversation turn
// No trigger words needed. Hebrew / English / mixed.

const NOTION_VERSION = '2022-06-28';
const MASTER_CRM_ID = '65013e2e-2627-4a71-ac3b-bd212f5671e3';
const DECISIONS_DB  = 'b5f664f6-14b4-4667-be32-d2db9b9cdb65'; // FIX 2026-06-07: was b5f664f6-b9e4… (no such source). Live OPEN DECISIONS source.

// Stage options in Master CRM
const STAGES = ['חדש', 'יצרנו קשר', 'מעוניין', 'הצעה נשלחה', 'סגור - שולם', 'קפא'];
const PROJECTS = ['Lotar', 'Financia', 'Mortgage', 'AAF', 'Tax Liens', 'Symbio', 'Other'];

// Save deal to Master CRM Notion DB
async function saveDeal(deal, token) {
  const props = {
    'Name': { title: [{ text: { content: deal.name } }] },
    'Stage': { select: { name: deal.stage || 'חדש' } },
    'Project': { select: { name: deal.project || 'Other' } },
    'Notes': { rich_text: [{ text: { content: deal.notes || '' } }] },
  };
  if (deal.value) props['Expected Value'] = { number: deal.value };
  if (deal.temperature) {
    const tempMap = { hot: '🔴 רותח', warm: '🟠 חם', cold: '🔵 קר' };
    props['Temperature'] = { select: { name: tempMap[deal.temperature] || '🟡 פושר' } };
  }

  const res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ parent: { database_id: MASTER_CRM_ID }, properties: props })
  });
  return res.ok;
}

// Save decision to OPEN DECISIONS DB  (FIX 2026-06-07: correct property names + date)
async function saveDecision(decision, token) {
  const today = new Date().toISOString().slice(0, 10);
  const res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      parent: { database_id: DECISIONS_DB },
      properties: {
        'Title': { title: [{ text: { content: decision.slice(0, 100) } }] },
        'Decision': { rich_text: [{ text: { content: decision } }] },
        'Date': { date: { start: today } }
      }
    })
  });
  return res.ok;
}

// Run Claude extraction on conversation turn
async function extractEntities(userMsg, assistantMsg, apiKey) {
  const prompt = `Analyze this conversation and extract business entities.
Return ONLY valid JSON, no markdown, no explanation.

Conversation:
User: ${userMsg}
Assistant: ${assistantMsg}

Extract and return:
{
  "deals": [
    {
      "name": "person or company name",
      "project": "${PROJECTS.join('|')}",
      "value": number_or_null,
      "stage": "${STAGES.join('|')}",
      "temperature": "hot|warm|cold|null",
      "notes": "max 80 chars context",
      "confidence": 0.0_to_1.0
    }
  ],
  "contacts": [
    {
      "name": "full name",
      "phone": "if stated or null",
      "email": "if stated or null",
      "role": "brief context",
      "project": "${PROJECTS.join('|')}",
      "confidence": 0.0_to_1.0
    }
  ],
  "decisions": [
    {
      "text": "what was decided (max 120 chars)",
      "confidence": 0.0_to_1.0
    }
  ]
}

Rules:
- Only include items with confidence >= 0.75
- Detect IMPLICIT mentions — "talked to David about training" = deal candidate
- Work in Hebrew, English, or mixed
- Deals: any mention of a specific person/org + business context + potential transaction
- Contacts: any named person mentioned in business context
- Decisions: explicit commitments or choices made
- If a contact is clearly just a general example, skip it
- Return {"deals":[],"contacts":[],"decisions":[]} if nothing qualifies`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',  // Fast + cheap for extraction
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!res.ok) return null;
  const data = await res.json();
  const text = data.content?.[0]?.text || '{}';

  try {
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch(e) {
    return null;
  }
}

// Format confirmation summary for the user
function formatConfirmation(saved, lang) {
  if (!saved.length) return '';
  const isHebrew = lang === 'he';
  const lines = saved.map(s => {
    if (s.type === 'deal') return `📊 ${isHebrew ? 'עסקה' : 'Deal'}: ${s.name}${s.project ? ` · ${s.project}` : ''}${s.value ? ` · ₪${s.value.toLocaleString()}` : ''}`;
    if (s.type === 'contact') return `👤 ${isHebrew ? 'איש קשר' : 'Contact'}: ${s.name}${s.role ? ` · ${s.role}` : ''}`;
    if (s.type === 'decision') return `✅ ${isHebrew ? 'החלטה' : 'Decision'}: ${s.text}`;
    return '';
  }).filter(Boolean);
  if (!lines.length) return '';
  const prefix = isHebrew ? '\n\n*לכדתי:*' : '\n\n*Captured:*';
  return prefix + '\n' + lines.join('\n');
}

// Detect language of message
function detectLang(text) {
  const hebrewChars = (text.match(/[\u0590-\u05FF]/g) || []).length;
  return hebrewChars > text.length * 0.15 ? 'he' : 'en';
}

exports.handler = async (event) => {
  const cors = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  try {
    const { userMessage, assistantReply, uid } = JSON.parse(event.body || '{}');
    if (!userMessage || !assistantReply) return { statusCode: 200, headers: cors, body: JSON.stringify({ confirmation: '' }) };

    const ownerUID = (process.env.OWNER_UID || '').trim();
    if (!ownerUID || uid !== ownerUID) return { statusCode: 200, headers: cors, body: JSON.stringify({ confirmation: '' }) };

    const apiKey = process.env.ANTHROPIC_API_KEY;
    const notionToken = process.env.NOTION_TOKEN;
    if (!apiKey || !notionToken) return { statusCode: 200, headers: cors, body: JSON.stringify({ confirmation: '' }) };

    const extracted = await extractEntities(userMessage, assistantReply, apiKey);
    if (!extracted) return { statusCode: 200, headers: cors, body: JSON.stringify({ confirmation: '' }) };

    const lang = detectLang(userMessage);
    const saved = [];

    for (const deal of (extracted.deals || [])) {
      if (deal.confidence >= 0.75 && deal.name) {
        const ok = await saveDeal(deal, notionToken);
        if (ok) saved.push({ type: 'deal', name: deal.name, project: deal.project, value: deal.value });
      }
    }

    for (const contact of (extracted.contacts || [])) {
      if (contact.confidence >= 0.75 && contact.name) {
        const ok = await saveDeal({
          name: contact.name,
          project: contact.project || 'Other',
          stage: 'חדש',
          notes: contact.role || '',
          temperature: null,
          value: null
        }, notionToken);
        if (ok) saved.push({ type: 'contact', name: contact.name, role: contact.role });
      }
    }

    for (const decision of (extracted.decisions || [])) {
      if (decision.confidence >= 0.75 && decision.text) {
        await saveDecision(decision.text, notionToken).catch(() => {});
        saved.push({ type: 'decision', text: decision.text });
      }
    }

    const confirmation = formatConfirmation(saved, lang);
    return { statusCode: 200, headers: cors, body: JSON.stringify({ confirmation, count: saved.length }) };

  } catch(e) {
    console.error('[extract]', e.message);
    return { statusCode: 200, headers: cors, body: JSON.stringify({ confirmation: '' }) };
  }
};
