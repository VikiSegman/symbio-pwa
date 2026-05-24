exports.handler = async (event) => {
  const ownerUID = (process.env.OWNER_UID || '').trim();
  const uid = (event.queryStringParameters || {}).uid || '';
  if (!ownerUID || uid !== ownerUID) {
    return { statusCode: 200,
      headers: {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'},
      body: JSON.stringify({ deals: [], totalPipeline: 0, hot: 0, leads: 0 }) };
  }
  try {
    const token = process.env.NOTION_TOKEN;
    if (!token) return { statusCode:200, headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}, body: JSON.stringify({error:'NOTION_TOKEN not set'}) };

    const res = await fetch('https://api.notion.com/v1/databases/4c5ed358-f66a-45cb-9434-e5f8562017e1/query', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ page_size: 20, sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }] })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Notion error');

    let totalPipeline = 0, hot = 0, leads = 0;
    const deals = (data.results || []).map(p => {
      const props = p.properties || {};
      const titleProp = props.Name || props.Title || props['שם'] || Object.values(props).find(v => v.type === 'title');
      const name = titleProp?.title?.map(t => t.plain_text).join('') || 'Deal';
      // Find value field
      const valProp = props.Value || props['ערך'] || props.Amount || props['סכום'] || Object.values(props).find(v => v.type === 'number');
      const value = valProp?.number || 0;
      // Find status
      const statusProp = props.Status || props['סטטוס'] || props.Stage || Object.values(props).find(v => v.type === 'select' || v.type === 'status');
      const status = statusProp?.select?.name || statusProp?.status?.name || '';
      totalPipeline += value;
      if (status.includes('hot') || status.includes('רותח') || status.includes('90') || status.includes('85')) hot++;
      else if (value > 0) leads++;
      return { name, value, status };
    }).filter(d => d.name !== 'Deal' || d.value > 0);

    return {
      statusCode: 200,
      headers: {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'},
      body: JSON.stringify({ deals, totalPipeline, hot, leads, count: deals.length })
    };
  } catch(e) {
    return { statusCode:200, headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}, body: JSON.stringify({error: e.message, deals:[]}) };
  }
};