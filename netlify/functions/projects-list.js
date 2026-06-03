// Symbio — list a user's projects (online, per-user). Uses service-role key; RLS-safe.
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
        res.on('end',()=>{ try{ resolve(JSON.parse(d||'[]')); }catch(e){ resolve([]); } });
      });
      req.on('error',()=>resolve([]));
      if(data) req.write(data);
      req.end();
    }catch(e){ resolve([]); }
  });
}

exports.handler = async (event) => {
  const cors = { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' };
  if(event.httpMethod==='OPTIONS') return { statusCode:200, headers:cors, body:'' };
  if(event.httpMethod!=='POST') return { statusCode:405, headers:cors, body:'Method Not Allowed' };
  try{
    const body = JSON.parse(event.body||'{}');
    const uid = (body.uid||'').trim();
    if(!uid) return { statusCode:200, headers:cors, body: JSON.stringify({ projects: [] }) };
    const rows = await sb('GET','/rest/v1/user_projects?user_id=eq.'+encodeURIComponent(uid)+'&order=sort.asc,created_at.asc', null);
    return { statusCode:200, headers:cors, body: JSON.stringify({ projects: Array.isArray(rows)?rows:[] }) };
  }catch(e){
    return { statusCode:200, headers:cors, body: JSON.stringify({ projects: [] }) };
  }
};
