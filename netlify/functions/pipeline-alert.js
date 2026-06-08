// pipeline-alert.js — Symbio Deal Intelligence
// Detects: overdue next-actions, cold deals, hot deals stalling
// Called by: Make.com daily 06:45 + on-demand

const NOTION_VERSION = '2022-06-28';
const MASTER_CRM     = '65013e2e-2627-4a71-ac3b-bd212f5671e3';
const ACTION_LOG_DB  = 'fd9d5f7a-ed64-4ecb-bb57-d710e9bf3d04'; // FIX 2026-06-07: was f8f2… (no such source)
const CONSCIOUSNESS  = '35db1191-5d41-81d5-a860-f409e6ad6a7b';

const COLD_DAYS = 14;   // deal flagged cold after 14 days no movement
const HOT_STALE = 7;    // hot deal flagged if no next-action in 7 days

function daysDiff(dateStr) {
  if (!dateStr) return 999;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

function isActive(stage) {
  return !['סגור - שולם','קפא','closed','won','lost','frozen'].some(s => (stage||'').toLowerCase().includes(s));
}

async function queryCRM(token) {
  const r = await fetch(`https://api.notion.com/v1/databases/${MASTER_CRM}/query`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
    body: JSON.stringify({ page_size: 100, sorts: [{ property: 'Next Action', direction: 'ascending' }] })
  });
  if (!r.ok) return [];
  const d = await r.json();

  return (d.results || []).map(p => {
    const pr = p.properties || {};
    const name     = Object.values(pr).find(x => x.type==='title')?.title?.map(t=>t.plain_text).join('') || '';
    const stage    = pr.Stage?.select?.name || pr.Status?.status?.name || '';
    const temp     = pr.Temperature?.select?.name || '';
    const priority = pr.Priority?.select?.name || '';
    const value    = pr['Expected Value']?.number || 0;
    const prob     = pr['Probability %']?.number || 0;
    const nextAct  = pr['Next Action']?.date?.start || pr['Next Action Date']?.date?.start || '';
    const lastCon  = pr['Last Contact']?.date?.start || '';
    const project  = pr.Project?.select?.name || '';
    const nextNote = pr['Next Action Note']?.rich_text?.map(t=>t.plain_text).join('') || '';
    const closeD   = pr['Close Date']?.date?.start || '';

    return { id: p.id, name, stage, temp, priority, value, prob, nextAct, lastCon, project, nextNote, closeD,
             active: isActive(stage),
             daysOverdue: nextAct ? daysDiff(nextAct) : -1,
             daysCold: lastCon ? daysDiff(lastCon) : (nextAct ? daysDiff(nextAct) : 999),
             isHot: temp.includes('רותח') || temp.includes('hot') || priority.includes('דחוף') };
  }).filter(d => d.name && d.active);
}

function buildAlerts(deals) {
  const today = new Date().toISOString().split('T')[0];
  const alerts = [];

  for (const d of deals) {
    // Overdue next-action
    if (d.daysOverdue > 0) {
      alerts.push({
        type: 'overdue',
        urgency: d.isHot ? 'critical' : 'high',
        deal: d.name,
        project: d.project,
        value: d.value,
        prob: d.prob,
        message: `⏰ ${d.daysOverdue}d overdue${d.nextNote ? ': ' + d.nextNote : ''}`,
        action: d.nextNote || 'Follow up required',
        closeDate: d.closeD
      });
    }
    // Going cold (no contact + no next-action)
    else if (d.daysCold > COLD_DAYS && !d.isHot) {
      alerts.push({
        type: 'cold',
        urgency: 'medium',
        deal: d.name,
        project: d.project,
        value: d.value,
        message: `🧊 ${d.daysCold}d no contact — going cold`,
        action: 'Re-engage or update stage'
      });
    }
    // Hot deal stalling
    else if (d.isHot && d.daysCold > HOT_STALE) {
      alerts.push({
        type: 'hot_stale',
        urgency: 'high',
        deal: d.name,
        project: d.project,
        value: d.value,
        prob: d.prob,
        message: `🔥 Hot deal stalled ${d.daysCold}d — needs action`,
        action: d.nextNote || 'Move forward or update temperature'
      });
    }
  }

  // Sort: critical → high → medium
  const order = { critical: 0, high: 1, medium: 2 };
  return alerts.sort((a, b) => (order[a.urgency]||9) - (order[b.urgency]||9));
}

async function saveAlertsToNotion(alerts, token) {
  if (!alerts.length) return;
  const today = new Date().toISOString().split('T')[0];
  const summary = alerts.map(a => `${a.message} | ${a.deal} | ${a.action}`).join('\n');

  await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      parent: { database_id: ACTION_LOG_DB },
      properties: {
        'Name': { title: [{ text: { content: `🚨 Pipeline Alert — ${today} (${alerts.length} items)` } }] },
        'Notes': { rich_text: [{ text: { content: summary.slice(0, 2000) } }] }
      }
    })
  });
}

exports.handler = async (event) => {
  const cors = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const ownerUID = (process.env.OWNER_UID || '').trim();
  const uid = (event.queryStringParameters || {}).uid ||
              (event.httpMethod === 'POST' ? JSON.parse(event.body||'{}').uid : '');

  if (!ownerUID || uid !== ownerUID)
    return { statusCode: 200, headers: cors, body: JSON.stringify({ alerts: [], auth: false }) };

  const token = process.env.NOTION_TOKEN;
  if (!token) return { statusCode: 200, headers: cors, body: JSON.stringify({ alerts: [], error: 'no token' }) };

  try {
    const deals  = await queryCRM(token);
    const alerts = buildAlerts(deals);

    // Save to Notion if there are critical/high alerts
    const urgent = alerts.filter(a => a.urgency !== 'medium');
    if (urgent.length) await saveAlertsToNotion(urgent, token).catch(() => {});

    // Pipeline summary
    const active    = deals.filter(d => d.active);
    const totalVal  = active.reduce((s, d) => s + (d.value || 0), 0);
    const weighted  = active.reduce((s, d) => s + (d.value || 0) * ((d.prob || 100) / 100), 0);

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        alerts,
        summary: {
          totalDeals: active.length,
          totalValue: totalVal,
          weightedValue: Math.round(weighted),
          overdueCount: alerts.filter(a => a.type === 'overdue').length,
          hotDeals: active.filter(d => d.isHot).length
        }
      })
    };
  } catch(e) {
    return { statusCode: 200, headers: cors, body: JSON.stringify({ alerts: [], error: e.message }) };
  }
};
