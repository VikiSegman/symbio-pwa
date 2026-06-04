const https = require('https');
function getKey(){
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_ANON_KEY;
}
function sb(method, path, body){
  return new Promise((resolve)=>{ try{
    const url=new URL(process.env.SUPABASE_URL); const key=getKey(); const data=body?JSON.stringify(body):null;
    const req=https.request({hostname:url.hostname,path:path,method:method,headers:{'apikey':key,'Authorization':'Bearer '+key,'Content-Type':'application/json','Prefer':'return=representation'}},
      (res)=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{resolve(JSON.parse(d||'[]'));}catch(e){resolve(null);}});});
    req.on('error',()=>resolve(null)); if(data)req.write(data); req.end();
  }catch(e){resolve(null);} });
}
function parseIntent(raw){
  if(!raw) return null;
  let t = String(raw).trim().replace(/^["'\u201C\u201D\s,.:;!-]+/, '');
  const he    = t.match(/^(?:צור|תצור|פתח|תפתח|הוסף|תוסיף|הקם|תקים)\s+פרוי?יקט\s+(.+)$/);
  const heNew = t.match(/^פרוי?יקט\s+חדש[:\s]+(.+)$/);
  const en    = t.match(/^(?:create|add|open|start|make|new)\s+(?:a\s+)?project[:\s]+(.+)$/i);
  let name = (he && he[1]) || (heNew && heNew[1]) || (en && en[1]) || null;
  if(!name) return null;
  name = name.trim().replace(/^["'\u201C\u201D]+|["'\u201C\u201D]+$/g,'').trim();
  name = name.split(/[\n\r]|[.!?]|,| - | – /)[0].trim().slice(0,80);
  return name.length < 2 ? null : name;
}
exports.handler = async (event)=>{
  const cors={'Content-Type':'application/json','Access-Control-Allow-Origin':'*'};
  if(event.httpMethod==='OPTIONS') return {statusCode:200,headers:cors,body:''};
  if(event.httpMethod!=='POST') return {statusCode:405,headers:cors,body:'Method Not Allowed'};
  try{
    const body=JSON.parse(event.body||'{}'); const uid=(body.uid||'').trim();
    const text=(body.text||body.message||'').toString();
    if(!uid) return {statusCode:200,headers:cors,body:JSON.stringify({created:false})};
    const name=parseIntent(text);
    if(!name) return {statusCode:200,headers:cors,body:JSON.stringify({created:false})};
    const row={user_id:uid,name:name,sub:'',color:'#7B6FFF',state:'idle'};
    const created=await sb('POST','/rest/v1/user_projects',row);
    const proj=Array.isArray(created)?created[0]:created;
    if(!proj) return {statusCode:200,headers:cors,body:JSON.stringify({created:false})};
    return {statusCode:200,headers:cors,body:JSON.stringify({created:true,project:proj})};
  }catch(e){ return {statusCode:200,headers:cors,body:JSON.stringify({created:false})}; }
};
