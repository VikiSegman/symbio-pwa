// Symbio — create a project for a user (online, per-user). Uses service-role key; RLS-safe.
const https = require('https');

function getKey(){
  return process.env.SUPABASE_SERVICE_ROLE_KEY
      || process.env.SUPABASE_SERVICE_KEY
      || process.env.SUPABASE_SECRET_KEY
      || process.env.SUPABASE_ANON_KEY;
}
function sb(method, path, body){
  return new Promise((resolve) => {
    try{
      const url = new URL(process.env.SUPABASE_URL);
      const key = getKey();
      const data = body ? JSON.stringify(body) : null;
      const req = https.request({
        hostname: url.hostname, path: path, method: method,
        headers: {
          'apikey': key,
          'Authorization': 'Bearer ' + key,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        }
      }, (res) => {
        let d=''; res.on('data',c=>d+=c);
        res.on('end',()=>{ try{ resolve(JSON.parse(d||'[]')); }catch(e){ resolve(null); } });
      });
      req.on('error',()=>resolve(null));
      if(data) req.write(data);
      req.end();
    }catch(e){ resolve(null); }
  });
}

exports.handler = async (event) => {
  const cors = { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' };
  if(event.httpMethod==='OPTIONS') return { statusCode:200, headers:cors, body:'' };
  if(event.httpMethod!=='POST') return { statusCode:405, headers:cors, body:'Method Not Allowed' };
  try{
    const body = JSON.parse(event.body||'{}');
    const uid = (body.uid||'').trim();
    const name = (body.name||'').trim().slice(0,80);
    if(!uid || !name) return { statusCode:400, headers:cors, body: JSON.stringify({ error:'uid and name required' }) };
    const row = {
      user_id: uid,
      name: name,
      sub: (body.sub||'').toString().slice(0,160),
      color: (body.color||'#7B6FFF').toString().slice(0,9),
      state: (body.state||'idle').toString().slice(0,20)
    };
    const created = await sb('POST','/rest/v1/user_projects', row);
    const proj = Array.isArray(created) ? created[0] : created;
    return { statusCode:200, headers:cors, body: JSON.stringify({ project: proj || row }) };
  }catch(e){
    return { statusCode:200, headers:cors, body: JSON.stringify({ error:'create failed' }) };
  }
};
