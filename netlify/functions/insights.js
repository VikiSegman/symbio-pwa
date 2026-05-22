exports.handler = async () => {
  try {
    const token = process.env.NOTION_TOKEN;
    if (!token) return { statusCode:200, headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}, body: JSON.stringify({error:'NOTION_TOKEN not set'}) };

    const res = await fetch('https://api.notion.com/v1/databases/c78c819e-11f4-4c01-bc4c-1b0df70e12b2/query', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ page_size: 10, sorts: [{ timestamp: 'created_time', direction: 'descending' }] })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Notion error');

    const insights = (data.results || []).map(p => {
      const props = p.properties || {};
      // Try common title field names
      const titleProp = props.Name || props.Title || props.Insight || props['תובנה'] || Object.values(props).find(v => v.type === 'title');
      const title = titleProp?.title?.map(t => t.plain_text).join('') || 'Untitled';
      const created = p.created_time?.slice(0,10) || '';
      return { title, created, id: p.id };
    }).filter(i => i.title !== 'Untitled');

    return {
      statusCode: 200,
      headers: {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'},
      body: JSON.stringify({ insights })
    };
  } catch(e) {
    return { statusCode:200, headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}, body: JSON.stringify({error: e.message}) };
  }
};