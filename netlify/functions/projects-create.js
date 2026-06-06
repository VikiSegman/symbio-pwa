// Symbio — create a project for a user. Identity from token (canonical); RLS-safe via service key.
const https = require('https');
function getKey(){
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_ANON_KEY;
}
function sb(method, path, body){
  return new Promise((resolve) => {
    try{
      const url = new URL(process.env.SUPABASE_URL); const key = getKey(); const data = body ? JSON.stringify(body) : null;
      const req = https.request({ hostname: url.hostname, path: path, method: method,
        headers: { 'apikey': key, 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'Prefer': 'return=representation' }
      }, (res) => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{ resolve(JSON.parse(d||'[]')); }catch(e){ resolve(null); } }); });
      req.on('error',()=>resolve(null)); if(data) req.write(data); req.end();
    }catch(e){ resolve(null); }
  });
}
async function resolveCanonical(event, bodyUid){
  const token=(event.headers.authorization||event.headers.Authorization||'').replace(/^Bearer\s+/i,'');
  if(token){
    try{
      const ures=await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`,{headers:{apikey:process.env.SUPABASE_ANON_KEY,Authorization:`Bearer ${token}`}});
      const u=await ures.json();
      if(u && u.id){
        const prof=await sb('GET',`/rest/v1/user_profiles?supabase_uid=eq.${encodeURIComponent(u.id)}&select=user_id&limit=1`,null);
        if(Array.isArray(prof)&&prof[0]&&prof[0].user_id) return prof[0].user_id;
      }
    }catch(e){}
  }
  return (bodyUid||'').trim();
}
exports.handler = async (event) => {
  const cors = { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'Content-Type, Authorization' };
  if(event.httpMethod==='OPTIONS') return { statusCode:200, headers:cors, body:'' };
  if(event.httpMethod!=='POST') return { statusCode:405, headers:cors, body:'Method Not Allowed' };
  try{
    const body = JSON.parse(event.body||'{}');
    const uid = await resolveCanonical(event, body.uid);
    const name = (body.name||'').trim().slice(0,80);
    if(!uid || !name) return { statusCode:400, headers:cors, body: JSON.stringify({ error:'identity or name missing' }) };
    const row = {
      user_id: uid, name: name,
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
