exports.handler = async (event) => {
  const ownerUID = (process.env.OWNER_UID || '').trim();
  const uid = (event.queryStringParameters || {}).uid || '';
  if (!ownerUID || uid !== ownerUID) {
    return { statusCode: 200,
      headers: {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'},
      body: JSON.stringify({ events: [] }) };
  }
  try {
    const url = process.env.GCAL_ICAL_URL;
    if (!url) return { statusCode:200, headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}, body: JSON.stringify({error:'GCAL_ICAL_URL not set', events:[]}) };

    const res = await fetch(url);
    const ical = await res.text();

    // Parse iCal events
    const events = [];
    const now = new Date();
    const todayStr = now.toISOString().slice(0,10).replace(/-/g,'');
    const tomorrowStr = new Date(now.getTime()+86400000).toISOString().slice(0,10).replace(/-/g,'');

    const blocks = ical.split('BEGIN:VEVENT');
    blocks.slice(1).forEach(block => {
      const get = (key) => {
        const m = block.match(new RegExp(key + '[^:]*:([^\r\n]+)'));
        return m ? m[1].trim() : '';
      };
      const dtstart = get('DTSTART').replace(/T.*/,'').replace(/-/g,'');
      const summary = get('SUMMARY').replace(/\n/g,' ');
      const dttime = get('DTSTART').includes('T') ? get('DTSTART').replace(/.*T(\d{2})(\d{2}).*/,'$1:$2') : 'All day';
      if ((dtstart === todayStr || dtstart === tomorrowStr) && summary) {
        events.push({ summary, time: dttime, day: dtstart === todayStr ? 'Today' : 'Tomorrow', dtstart });
      }
    });

    events.sort((a,b) => a.dtstart.localeCompare(b.dtstart));

    return {
      statusCode: 200,
      headers: {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'},
      body: JSON.stringify({ events: events.slice(0,12) })
    };
  } catch(e) {
    return { statusCode:200, headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}, body: JSON.stringify({error: e.message, events:[]}) };
  }
};