// session-save.js — Symbio Auto-Consciousness Updater
// Triggers: logout | 3-min pause | every 10 conversation turns
// Summarizes session → saves to SUMMARIES DB → appends to CONSCIOUSNESS

const NOTION_VERSION  = '2022-06-28';
const SUMMARIES_DB    = 'f6cfa6df-2fe1-4378-abfb-49f4a0b11fa6';  // collection ID
const INSIGHTS_DB     = 'b14f6bb6-254f-4927-ae2c-7ed8c4e1bca8';  // collection ID
const CONSCIOUSNESS   = '35db1191-5d41-81d5-a860-f409e6ad6a7b';  // page ID

// ── Notion helpers ────────────────────────────────────────────────────────────

async function notionPost(path, body, token) {
  const r = await fetch(`https://api.notion.com/v1/${path}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return r.ok ? await r.json() : null;
}

async function notionPatch(path, body, token) {
  const r = await fetch(`https://api.notion.com/v1/${path}`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return r.ok;
}

// ── Claude summarizer ─────────────────────────────────────────────────────────

async function summarizeSession(messages, trigger, apiKey) {
  const transcript = messages
    .slice(-20)  // last 20 turns max
    .map(m => `${m.role === 'user' ? 'Erez' : 'Symbio'}: ${m.content}`)
    .join('\n');

  const today = new Date().toISOString().split('T')[0];
  const triggerLabel = { logout: 'before logout', pause: '3-min pause', turns: 'every 10 turns' }[trigger] || trigger;

  const prompt = `Summarize this Symbio conversation session. Be concise and factual.
Date: ${today} | Trigger: ${triggerLabel}

Transcript:
${transcript}

Return ONLY valid JSON:
{
  "title": "SUM · [date] · [2-4 word topic]",
  "what_happened": "1-2 sentences. Concrete facts only.",
  "what_decided": "Key decisions made. Empty string if none.",
  "what_next": "Next actions identified. Empty string if none.",
  "insights": ["max 2 key insights worth remembering long-term"],
  "consciousness_update": "1-2 sentences to append to Symbio's live awareness. Only truly new/changed info."
}`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 500, messages: [{ role: 'user', content: prompt }] })
  });
  if (!r.ok) return null;
  const d = await r.json();
  try {
    return JSON.parse(d.content[0].text.replace(/```json|```/g, '').trim());
  } catch(e) { return null; }
}

// ── Save to SUMMARIES DB ──────────────────────────────────────────────────────

async function saveSummary(s, token) {
  const today = new Date().toISOString().split('T')[0];
  await notionPost('pages', {
    parent: { database_id: SUMMARIES_DB },
    properties: {
      'Title':          { title: [{ text: { content: s.title } }] },
      'What Happened':  { rich_text: [{ text: { content: s.what_happened } }] },
      'What Decided':   { rich_text: [{ text: { content: s.what_decided || '' } }] },
      'What Next':      { rich_text: [{ text: { content: s.what_next || '' } }] },
      'Project':        { select: { name: 'Symbio' } },
      'date:Date:start': today, 'date:Date:is_datetime': 0
    }
  }, token);
}

// ── Save insights ─────────────────────────────────────────────────────────────

async function saveInsights(insights, token) {
  for (const insight of insights) {
    if (!insight || insight.length < 10) continue;
    await notionPost('pages', {
      parent: { database_id: INSIGHTS_DB },
      properties: { 'Name': { title: [{ text: { content: insight.slice(0, 120) } }] } }
    }, token);
  }
}

// ── Append to CONSCIOUSNESS ───────────────────────────────────────────────────

async function updateConsciousness(update, trigger, token) {
  if (!update || update.length < 10) return;
  const today = new Date().toISOString().split('T')[0];
  const time  = new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  const label = { logout: 'LOGOUT', pause: 'PAUSE', turns: '10-TURNS' }[trigger] || 'AUTO';

  // Append a brief block to CONSCIOUSNESS page
  await notionPatch(`blocks/${CONSCIOUSNESS}/children`, {
    children: [{
      object: 'block', type: 'paragraph',
      paragraph: {
        rich_text: [{
          type: 'text',
          text: { content: `[${today} ${time} · ${label}] ${update}` },
          annotations: { color: 'gray' }
        }]
      }
    }]
  }, token);
}

// ── Handler ───────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const cors = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  try {
    const { messages, uid, trigger = 'manual' } = JSON.parse(event.body || '{}');

    const ownerUID = (process.env.OWNER_UID || '').trim();
    if (!ownerUID || uid !== ownerUID)
      return { statusCode: 200, headers: cors, body: JSON.stringify({ saved: false, reason: 'not owner' }) };

    if (!messages || messages.length < 2)
      return { statusCode: 200, headers: cors, body: JSON.stringify({ saved: false, reason: 'no content' }) };

    const apiKey     = process.env.ANTHROPIC_API_KEY;
    const notionToken = process.env.NOTION_TOKEN;
    if (!apiKey || !notionToken)
      return { statusCode: 200, headers: cors, body: JSON.stringify({ saved: false, reason: 'missing keys' }) };

    // Summarize + save in parallel
    const summary = await summarizeSession(messages, trigger, apiKey);
    if (!summary)
      return { statusCode: 200, headers: cors, body: JSON.stringify({ saved: false, reason: 'summarize failed' }) };

    await Promise.all([
      saveSummary(summary, notionToken),
      saveInsights(summary.insights || [], notionToken),
      updateConsciousness(summary.consciousness_update, trigger, notionToken)
    ]);

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({ saved: true, title: summary.title, trigger })
    };

  } catch(e) {
    console.error('[session-save]', e.message);
    return { statusCode: 200, headers: cors, body: JSON.stringify({ saved: false, error: e.message }) };
  }
};
