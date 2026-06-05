// netlify/functions/faculty-session-brief.js  (B2a — CORRECTED v2)
// Fix vs v1: owner memories are keyed under 'erez', not the UUID -> resolve memKey for the memory read.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL;
const OWNER_UID = process.env.OWNER_UID || 'ae001f0a-3e86-42d5-96a7-189fa2e4379c';
const OWNER_MEM_KEY = process.env.OWNER_MEM_KEY || 'erez';
const MAX_BATCH = 10;

const sb = (path, opts = {}) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(opts.headers||{}) } });

exports.handler = async (event) => {
  try {
    if (!SUPABASE_URL || !SERVICE_KEY) return json(500,{error:'Supabase env missing'});
    if (!ANTHROPIC_KEY || !MODEL) return json(500,{error:'ANTHROPIC_API_KEY or ANTHROPIC_MODEL missing'});
    let body={}; try{ body=JSON.parse(event.body||'{}'); }catch(_){}
    let uids = Array.isArray(body.uids)&&body.uids.length ? body.uids : [OWNER_UID];
    uids = uids.slice(0, MAX_BATCH);
    const results=[];
    for (const uid of uids) {
      const isSyn=String(uid).startsWith('syn_');
      const provenance=isSyn?'synthetic':'real';
      const memKey=(String(uid)===String(OWNER_UID))?OWNER_MEM_KEY:uid;
      const t0=Date.now();
      try {
        const [projects, memories] = await Promise.all([
          sb(`user_projects?user_id=eq.${encodeURIComponent(uid)}&select=name,sub,state`).then(r=>r.json()),
          sb(`memories?user_id=eq.${encodeURIComponent(memKey)}&select=content&order=created_at.desc&limit=10`).then(r=>r.json())
        ]);
        const ctxProjects=(projects||[]).map(p=>`- ${p.name}${p.sub?' ('+p.sub+')':''} [${p.state||''}]`).join('\n')||'(none)';
        const ctxMemory=(memories||[]).map(m=>`- ${m.content}`).join('\n')||'(none)';
        const prompt=`You are Symbio, this user's persistent assistant. Produce an ULTRA-BRIEF daily session brief.\nFormat exactly:\n🔴 URGENT (max 2)\n📋 OPEN (max 3)\n💡 TODAY'S FOCUS (1)\nBe specific and terse. If nothing is urgent, say so. Do NOT invent goals the user has not expressed.\n\nProjects:\n${ctxProjects}\n\nRecent memory:\n${ctxMemory}`;
        const resp=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01','Content-Type':'application/json'},body:JSON.stringify({model:MODEL,max_tokens:400,messages:[{role:'user',content:prompt}]})});
        const data=await resp.json();
        if(!resp.ok) throw new Error(`anthropic ${resp.status}: ${JSON.stringify(data).slice(0,200)}`);
        const brief=(data.content||[]).map(b=>b.text||'').join('').trim()||'(empty)';
        const tin=data.usage?.input_tokens??null, tout=data.usage?.output_tokens??null;
        await sb('user_insights',{method:'POST',body:JSON.stringify({user_id:uid,faculty:'session_brief',content:brief,provenance,is_synthetic:isSyn})});
        await sb('notifications',{method:'POST',body:JSON.stringify({user_id:uid,faculty:'session_brief',title:'Daily Brief',body:brief,provenance,is_synthetic:isSyn})});
        await sb('faculty_runs',{method:'POST',body:JSON.stringify({faculty:'session_brief',user_id:uid,status:'success',model:MODEL,tokens_in:tin,tokens_out:tout,duration_ms:Date.now()-t0,is_synthetic:isSyn})});
        results.push({uid,status:'success',tokens_in:tin,tokens_out:tout,synthetic:isSyn});
      } catch(e){
        await sb('faculty_runs',{method:'POST',body:JSON.stringify({faculty:'session_brief',user_id:uid,status:'fail',error:String(e).slice(0,300),model:MODEL,duration_ms:Date.now()-t0,is_synthetic:isSyn})});
        results.push({uid,status:'fail',error:String(e).slice(0,200),synthetic:isSyn});
      }
    }
    return json(200,{faculty:'session_brief',count:results.length,results});
  } catch(e){ return json(500,{error:String(e).slice(0,300)}); }
};
function json(s,o){return{statusCode:s,headers:{'Content-Type':'application/json'},body:JSON.stringify(o)};}
