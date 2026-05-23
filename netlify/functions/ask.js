const https = require('https');

function supabaseGet(path) {
  return new Promise((resolve) => {
    if (!process.env.SUPABASE_URL) return resolve([]);
    const host = new URL(process.env.SUPABASE_URL).hostname;
    const req = https.request({
      hostname: host, path, method: 'GET',
      headers: { 'apikey': process.env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' }
    }, (res) => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve(JSON.parse(d)||[]);}catch(e){resolve([]);} }); });
    req.on('error',()=>resolve([])); req.setTimeout(5000,()=>{req.destroy();resolve([]);});req.end();
  });
}

function supabasePost(path, body, method) {
  return new Promise((resolve) => {
    if (!process.env.SUPABASE_URL) return resolve({status:500});
    const host = new URL(process.env.SUPABASE_URL).hostname;
    const bodyStr = JSON.stringify(body);
    const req = https.request({
      hostname: host, path, method: method||'POST',
      headers: { 'apikey': process.env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr), 'Prefer': 'return=minimal' }
    }, (res) => { res.on('data',()=>{}); res.on('end',()=>resolve({status:res.statusCode})); });
    req.on('error',()=>resolve({status:500})); req.setTimeout(8000,()=>{req.destroy();resolve({status:408});}); req.write(bodyStr); req.end();
  });
}

function getEmbedding(text) {
  return new Promise((resolve) => {
    const body = JSON.stringify({model:'text-embedding-3-small',input:text.slice(0,4000)});
    const req = https.request({
      hostname:'api.openai.com', path:'/v1/embeddings', method:'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve(JSON.parse(d).data?.[0]?.embedding||null);}catch(e){resolve(null);} }); });
    req.on('error',()=>resolve(null)); req.setTimeout(15000,()=>{req.destroy();resolve(null);}); req.write(body); req.end();
  });
}

async function searchMemories(embedding) {
  if (!process.env.SUPABASE_URL) return [];
  const host = new URL(process.env.SUPABASE_URL).hostname;
  let semantic = [];
  if (embedding) {
    const body = JSON.stringify({query_embedding:embedding,match_threshold:0.50,match_count:4,filter_user_id:'erez'});
    semantic = await new Promise((resolve) => {
      const req = https.request({
        hostname:host, path:'/rest/v1/rpc/match_memories', method:'POST',
        headers: { 'apikey': process.env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, (res) => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve(JSON.parse(d)||[]);}catch(e){resolve([]);} }); });
      req.on('error',()=>resolve([])); req.setTimeout(5000,()=>{req.destroy();resolve([]);}); req.write(body); req.end();
    });
  }
  const recent = await supabaseGet('/rest/v1/memories?user_id=eq.erez&order=created_at.desc&limit=2');
  const all = [...(semantic||[])];
  const ids = new Set(all.map(m=>m.id));
  (recent||[]).forEach(m=>{ if(!ids.has(m.id)) all.push(m); });
  return all.slice(0,5);
}

async function saveMemory(content, embedding) {
  if (!embedding||!process.env.SUPABASE_URL) return false;
  const host = new URL(process.env.SUPABASE_URL).hostname;
  const body = JSON.stringify({user_id:'erez',content,embedding,memory_type:'conversation',session_date:new Date().toISOString().split('T')[0]});
  return new Promise((resolve) => {
    const req = https.request({
      hostname:host, path:'/rest/v1/memories', method:'POST',
      headers: { 'apikey': process.env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Prefer': 'return=minimal' }
    }, (res) => { res.on('data',()=>{}); res.on('end',()=>resolve(res.statusCode===201)); });
    req.on('error',()=>resolve(false)); req.setTimeout(8000,()=>{req.destroy();resolve(false);}); req.write(body); req.end();
  });
}

async function getRelevantPeople(message) {
  try {
    const all = await supabaseGet('/rest/v1/people?user_id=eq.erez&order=updated_at.desc&limit=20');
    if (!Array.isArray(all)||all.length===0) return [];
    const msgLower = message.toLowerCase();
    return all.filter(p => {
      const names = [p.name,...(p.name_variants||[])];
      return names.some(n=>n&&msgLower.includes(n.toLowerCase()));
    }).slice(0,3);
  } catch(e) { return []; }
}

async function updateLastContact(personName) {
  if (!process.env.SUPABASE_URL) return;
  try { await supabasePost(`/rest/v1/people?user_id=eq.erez&name=ilike.*${encodeURIComponent(personName)}*`,{last_contact:new Date().toISOString().split('T')[0]},'PATCH'); } catch(e) {}
}

async function autoDetectPerson(message, reply) {
  try {
    const combined = message+' '+reply;
    const existing = await supabaseGet('/rest/v1/people?user_id=eq.erez&select=name,name_variants');
    const known = new Set();
    (existing||[]).forEach(p=>{ known.add(p.name.toLowerCase()); (p.name_variants||[]).forEach(v=>known.add(v.toLowerCase())); });
    const patterns = [/עם ([א-ת]+ [א-ת]+)/g,/של ([א-ת]+ [א-ת]+)/g];
    const candidates = new Set();
    patterns.forEach(pattern=>{ let m; while((m=pattern.exec(combined))!==null){ const n=m[1].trim(); if(n.length>3&&!known.has(n.toLowerCase())) candidates.add(n); } });
    let saved=0;
    for (const name of candidates) {
      if(saved>=2) break;
      await supabasePost('/rest/v1/people',{user_id:'erez',name,relationship_type:'unknown',trust_level:3,notes:`זוהה אוטומטית: "${message.slice(0,80)}"`,projects:[]});
      saved++; console.log('[ask] auto-person:',name);
    }
  } catch(e) {}
}

async function getFinancialContext() {
  try {
    if (!process.env.SUPABASE_URL) return null;
    const host = new URL(process.env.SUPABASE_URL).hostname;
    const body = JSON.stringify({p_user_id:'erez'});
    return await new Promise((resolve) => {
      const req = https.request({
        hostname:host, path:'/rest/v1/rpc/get_financial_summary', method:'POST',
        headers: { 'apikey': process.env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, (res) => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve(JSON.parse(d));}catch(e){resolve(null);} }); });
      req.on('error',()=>resolve(null)); req.setTimeout(5000,()=>{req.destroy();resolve(null);}); req.write(body); req.end();
    });
  } catch(e) { return null; }
}

exports.handler = async (event) => {
  if (event.httpMethod!=='POST') return {statusCode:405,body:'Not Allowed'};
  try {
    const {message,project} = JSON.parse(event.body||'{}');
    if (!message) return {statusCode:400,body:JSON.stringify({error:'No message'})};

    const isFinancial = /ריבית|שריפה|חוב|תזרים|כסף|עלות|מש"|₪|interest|burn|financial/i.test(message);

    const [qEmbed, relevantPeople, financialData] = await Promise.all([
      getEmbedding(message),
      getRelevantPeople(message),
      isFinancial ? getFinancialContext() : Promise.resolve(null)
    ]);

    const memories = await searchMemories(qEmbed);

    let memoryContext = '';
    if (memories.length>0) {
      memoryContext = '\n\nזיכרונות רלוונטים:\n'+
        memories.map((m,i)=>`[זיכרון ${i+1} — ${m.session_date||m.created_at?.split('T')[0]||'עבר'}]\n${m.content}`).join('\n\n')+'\n';
    }

    let peopleContext = '';
    if (relevantPeople.length>0) {
      peopleContext = '\n\nאנשים רלוונטים:\n'+
        relevantPeople.map(p=>`• ${p.name} — ${p.role||''} | ${p.relationship_type||''} | אמון: ${p.trust_level}/10 | ${p.current_situation||''} | ${p.notes||''}`).join('\n')+'\n';
      relevantPeople.forEach(p=>updateLastContact(p.name));
    }

    let financialContext = '';
    if (financialData?.projects) {
      financialContext = '\n\nמצב פיננסי נוכחי:\n'+
        `• שריפה יומית: ₪${financialData.total_daily_burn?.toLocaleString()}\n`+
        `• שריפה חודשית: ₪${financialData.total_monthly_burn?.toLocaleString()}\n`+
        `• ריבית שנצברה סה"כ: ₪${financialData.total_interest_accrued?.toLocaleString()}\n`+
        financialData.projects.map(p=>`• ${p.name}: קרן ₪${p.principal?.toLocaleString()} | ${p.rate}% | נצבר ₪${p.interest_accrued?.toLocaleString()} | ₪${p.monthly_burn?.toLocaleString()}/חודש`).join('\n')+'\n';
    }

    const system = `אתה סימביו — מערכת ה-AI האישית של ארז סגמן (Erez Segman). ישיר, חד, דו-לשוני עברית/אנגלית. יועץ בכיר מהימן. פרויקט פעיל: ${project||'כללי'}. מטרות: 100K ש"ח/חודש — Financia (בת ים תמא 38/2, הרצליה), Lotar (הדרכות, אפריקה, חוות), ייעוץ משכנתאות (2% מינ˳ 12,500 ש"ח), AAF (תרומות), Tax Liens ארה"ב. כללי תגובה: 1-3 משפטים. רשימות: 3 מילות, מקסימום 5. אל תחזור. אותה שפה כמו המשתמש.${memoryContext}${peopleContext}${financialContext}`;

    const res = await fetch('https://api.anthropic.com/v1/messages',{
      method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},
      body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:1000,system,messages:[{role:'user',content:message}]})
    });

    const data = await res.json();
    const reply = data.content?.[0]?.text||data.error?.message||'אין תגובה';
    console.log(`[ask] reply:${reply.length} | memories:${memories.length} | people:${relevantPeople.length} | financial:${!!financialContext}`);

    const content = `User: ${message}\nSymbio: ${reply}`;
    const memEmb = await getEmbedding(content);
    const stored = await saveMemory(content, memEmb);
    console.log('[ask] memory stored:', stored);
    await autoDetectPerson(message, reply);

    return {statusCode:200,headers:{'Content-Type':'application/json'},body:JSON.stringify({reply})};
  } catch(error) {
    console.error('[ask] error:',error.message);
    return {statusCode:500,body:JSON.stringify({error:error.message})};
  }
};
