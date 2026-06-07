// session-save.js — Symbio Auto-Consciousness Updater
// Summarizes session → SUMMARIES + INSIGHTS; appends CONSCIOUSNESS on logout only.

const NOTION_VERSION  = '2022-06-28';
const SUMMARIES_DB    = 'f6cfa6df-2fe1-4378-abfb-49f4a0b11fa6';
const INSIGHTS_DB     = 'b14f6bb6-254f-4927-ae2c-7ed8c4e1bca8';
const CONSCIOUSNESS   = '35db1191-5d41-81d5-a860-f409e6ad6a7b';

// Full work only on real boundaries — skip tab-blur noise (hidden/pagehide/turns). [FIX 3]
const SAVE_TRIGGERS = ['logout', 'pause', 'manual'];

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

async function summarizeSession(messages, trigger, apiKey) {
  const transcript = messages
    .slice(-20)
    .map(m => `${m.role === 'user' ? 'Erez' : 'Symbio'}: ${m.content}`)
    .join('\n');

  const today = new Date().toISOString().split('T')[0];
  const triggerLabel = { logout: 'before logout', pause: '3-min pause', manual: 'manual save' }[trigger] || trigger;

  const prompt = `Summarize this Symbio conversation session. Be concise and factual.
Date: ${today} |
