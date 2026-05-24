// pipeline.js — Symbio Universal Pipeline Aggregator
// Queries ALL CRM databases dynamically — no hardcoded limits
// Auto-discovers Notion DBs + uses registered DB list

const NOTION_VERSION = '2022-06-28';
const PAGE_SIZE = 50;

// Known DB IDs as baseline — extended via PIPELINE_DB_IDS env var + auto-discovery
const BASELINE_DBS = [
  { id: '65013e2e-2627-4a71-ac3b-bd212f5671e3', name: 'Master CRM', primary: true },
  { id: 'c38e8b01-97a4-4bb5-a688-5664d67d5e63', name: 'Lotar CRM' },
  { id: '83341173-51d0-43fc-812b-06bbf1cc4775', name: 'Mortgage CRM' },
  { id: 'ef49803c-527f-4e46-be9b-0fb1532c16c0', name: 'Financia CRM' },
  { id: 'eb849fdf-0979-4db9-857c-4814097d7a7c', name: 'AAF CRM' },
  { id: 'f0e18543-0d79-45b0-bfef-7001ebec02bd', name: 'Donation Pipeline' },
  { id: 'b515874e-15d0-4560-b148-003709fbd0d8', name: 'Tax Lien Auctions' },
  { id: '4c5ed358-f66a-45cb-9434-e5f8562017e1', name: 'Leads & CRM' },
];

// Flexible field extractors — work with any schema
function getTitle(props) {
  const titleProp = Object.values(props).find(p => p.type === 'title');
  return titleProp?.title?.map(t => t.plain_text).join('').trim() || '';
}

function getNumber(props, fieldNames) {
  for (const name of fieldNames) {
    if (props[name]?.type === 'number' && props[name].number != null)
      return props[name].number;
  }
  // Fallback: any number field
  const numProp = Object.values(props).find(p => p.type === 'number' && p.number != null);
  return numProp?.number || 0;
}

function getSelect(props, fieldNames) {
  for (const name of fieldNames) {
    const p = props[name];
    if (!p) continue;
    if (p.type === 'select') return p.select?.name || '';
    if (p.type === 'status') return p.status?.name || '';
  }
  return '';
}

function getDate(props, fieldNames) {
  for (const name of fieldNames) {
    if (props[name]?.date?.start) return props[name].date.start;
  }
  return '';
}

function isHot(stage, temperature, priority) {
  const hot = ['רותח', 'hot', '🔴', 'מעוניין', 'הצעה נשלחה', 'negotiating', 'proposal'];
  const check = [stage, temperature, priority].join(' ').toLowerCase();
  return hot.some(h => check.includes(h));
}

function isActive(stage) {
  const closed = ['סגור', 'closed', 'won', 'lost', 'קפא', 'frozen'];
  return !closed.some(c => stage.toLowerCase().includes(c));
}

// Query a single Notion DB with flexible schema detection
async function queryDB(dbId, dbName, token) {
  try {
    const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        page_size: PAGE_SIZE,
        sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }]
      })
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (!data.results) return [];

    return data.results.map(page => {
      const props = page.properties || {};
      const name = getTitle(props);
      if (!name) return null;

      const value = getNumber(props, [
        'Expected Value', 'Deal Value', 'Value', 'Amount', 'Budget',
        'ערך', 'סכום', 'תקציב', 'מחיר', 'Bid Amount', 'Tax Amount'
      ]);
      const stage = getSelect(props, ['Stage', 'Status', 'שלב', 'סטטוס', 'Stage/Status']);
      const temperature = getSelect(props, ['Temperature', 'טמפרטורה', 'Heat', 'Priority', 'עדיפות']);
      const project = getSelect(props, ['Project', 'פרויקט', 'Business Area', 'Type', 'תחום']) || dbName;
      const nextAction = getDate(props, ['Next Action', 'Next Action Date', 'Due', 'Follow Up']);
      const contact = props['Contact']?.rich_text?.map(t => t.plain_text).join('') || 
                      props['Phone']?.phone_number || '';

      return {
        name, value, stage, temperature, project,
        nextAction, contact,
        hot: isHot(stage, temperature, ''),
        active: isActive(stage),
        source: dbName,
        id: page.id
      };
    }).filter(Boolean);
  } catch(e) {
    console.error(`[pipeline] DB ${dbName} (${dbId}): ${e.message}`);
    return [];
  }
}

// Auto-discover Notion databases that look like CRMs
async function discoverCRMDatabases(token) {
  const discovered = [];
  try {
    const keywords = ['crm', 'pipeline', 'leads', 'deals', 'clients', 'donors', 'auctions'];
    for (const kw of keywords) {
      const res = await fetch('https://api.notion.com/v1/search', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Notion-Version': NOTION_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: kw, filter: { value: 'database', property: 'object' }, page_size: 10 })
      });
      if (!res.ok) continue;
      const data = await res.json();
      for (const db of (data.results || [])) {
        if (db.object === 'database') {
          const title = db.title?.[0]?.plain_text || '';
          discovered.push({ id: db.id, name: title });
        }
      }
    }
  } catch(e) { /* discovery is best-effort */ }
  return discovered;
}

// Deduplicate by deal ID
function dedup(allDeals) {
  const seen = new Set();
  return allDeals.filter(d => {
    const key = d.id || `${d.name}::${d.project}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

exports.handler = async (event) => {
  const cors = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  const ownerUID = (process.env.OWNER_UID || '').trim();
  const uid = (event.queryStringParameters || {}).uid || '';
  if (!ownerUID || uid !== ownerUID) {
    return { statusCode: 200, headers: cors, body: JSON.stringify({ deals: [], totalPipeline: 0, hot: 0, leads: 0 }) };
  }

  const token = process.env.NOTION_TOKEN;
  if (!token) return { statusCode: 200, headers: cors, body: JSON.stringify({ error: 'NOTION_TOKEN missing' }) };

  try {
    // Build full DB list: baseline + env var extras + auto-discovered
    const dbMap = new Map(BASELINE_DBS.map(d => [d.id.replace(/-/g, ''), d]));

    // Extra DBs from env var (comma-separated IDs)
    const extraIds = (process.env.PIPELINE_DB_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
    for (const id of extraIds) {
      const clean = id.replace(/-/g, '');
      if (!dbMap.has(clean)) dbMap.set(clean, { id, name: 'Extra CRM' });
    }

    // Auto-discover (best effort — adds new DBs Erez creates)
    const discovered = await discoverCRMDatabases(token);
    for (const d of discovered) {
      const clean = d.id.replace(/-/g, '');
      if (!dbMap.has(clean)) dbMap.set(clean, d);
    }

    // Query all DBs in parallel
    const allDBs = [...dbMap.values()];
    const results = await Promise.all(allDBs.map(db => queryDB(db.id, db.name, token)));
    const allDeals = dedup(results.flat());

    // Aggregate metrics
    let totalPipeline = 0, hot = 0, leads = 0;
    const activeDeals = allDeals.filter(d => d.active);
    for (const d of activeDeals) {
      totalPipeline += d.value || 0;
      if (d.hot) hot++;
      else if (d.value > 0) leads++;
    }

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        deals: activeDeals,
        allDeals: allDeals.length,
        totalPipeline, hot, leads,
        dbsQueried: allDBs.length
      })
    };
  } catch(e) {
    return { statusCode: 200, headers: cors, body: JSON.stringify({ error: e.message, deals: [] }) };
  }
};
