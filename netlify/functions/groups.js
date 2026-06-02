// groups.js — Symbio Group self-serve (create/join/leave/list/post-note)
// SECURITY: identity is verified from the Supabase JWT (never trusted from the body).
// All DB writes use the service key; membership is the privilege boundary (§4/§16).

const https = require('https');
const crypto = require('crypto');

function req(method, host, path, headers, body) {
  return new Promise((resolve, reject) => {
    const buf = body ? JSON.stringify(body) : null;
    const h = { ...headers };
    if (buf) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(buf); }
    const r = https.request({ hostname: host, path, method, headers: h }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d || '{}') }); } catch(e) { resolve({ status: res.statusCode, body: d }); } });
    });
    r.on('error', reject);
    if (buf) r.write(buf);
    r.end();
  });
}

const SB_HOST = () => new URL(process.env.SUPABASE_URL).hostname;
const SVC = () => ({ 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}` });

async function audit(actor, action, resource, detail) {
  try { await req('POST', SB_HOST(), '/rest/v1/audit_log', { ...SVC(), 'Prefer': 'return=minimal' }, { actor, action, resource: resource || null, detail: detail || null }); } catch(e) {}
}

// Map a verified auth identity (uid + email) -> canonical user_id via user_profiles.
async function resolveProfile(sUid, email) {
  let r = await req('GET', SB_HOST(), `/rest/v1/user_profiles?supabase_uid=eq.${encodeURIComponent(sUid)}&select=user_id&limit=1`, SVC(), null);
  if (Array.isArray(r.body) && r.body[0] && r.body[0].user_id) return r.body[0].user_id;
  if (email) {
    r = await req('GET', SB_HOST(), `/rest/v1/user_profiles?email=eq.${encodeURIComponent(email)}&select=user_id&limit=1`, SVC(), null);
    if (Array.isArray(r.body) && r.body[0] && r.body[0].user_id) return r.body[0].user_id;
  }
  return null;
}

// Verify caller from their JWT. NEVER trusts the body. Self-heals stale tokens via refresh_token.
// Returns { userId, session, reason }. session is non-null only when a refresh produced a new one.
async function verifyUser(accessToken, refreshToken) {
  if (!accessToken && !refreshToken) return { userId: null, session: null, reason: 'no_token' };
  try {
    // 1) Try the access token as-is.
    if (accessToken) {
      const u = await req('GET', SB_HOST(), '/auth/v1/user', { 'apikey': process.env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${accessToken}` }, null);
      if (u.status === 200 && u.body && u.body.id) {
        const uid = await resolveProfile(u.body.id, u.body.email || '');
        return uid ? { userId: uid, session: null, reason: null } : { userId: null, session: null, reason: 'no_profile' };
      }
    }
    // 2) Access token missing/stale -> refresh server-side.
    if (refreshToken) {
      const rf = await req('POST', SB_HOST(), '/auth/v1/token?grant_type=refresh_token',
        { 'apikey': process.env.SUPABASE_ANON_KEY }, { refresh_token: refreshToken });
      if (rf.status === 200 && rf.body && rf.body.access_token && rf.body.user && rf.body.user.id) {
        const uid = await resolveProfile(rf.body.user.id, rf.body.user.email || '');
        if (!uid) return { userId: null, session: null, reason: 'no_profile' };
        return { userId: uid, session: rf.body, reason: null }; // hand fresh session back to client
      }
      return { userId: null, session: null, reason: 'refresh_failed' };
    }
    return { userId: null, session: null, reason: 'token_rejected' };
  } catch(e) {
    return { userId: null, session: null, reason: 'verify_error' };
  }
}

const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
const ok  = (b) => ({ statusCode: 200, headers: CORS, body: JSON.stringify(b) });
const err = (m, c=400) => ({ statusCode: c, headers: CORS, body: JSON.stringify({ error: m }) });

const TYPES = ['family','org','team','community','school','university','ngo','club','congregation'];

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return err('Method not allowed', 405);

  let p; try { p = JSON.parse(event.body || '{}'); } catch(e) { return err('Bad JSON'); }
  const { action, accessToken, refreshToken } = p;

  // SECURE IDENTITY — every action requires a valid token (self-heals stale tokens).
  const v = await verifyUser(accessToken, refreshToken);
  if (!v.userId) return err('auth_failed:' + (v.reason || 'unknown'), 401);
  const userId = v.userId;
  // If we refreshed, hand the new session back so the client can store it.
  const finish = (obj) => ok(v.session ? Object.assign({}, obj, { _session: v.session }) : obj);

  const host = SB_HOST();

  try {
    // ---- CREATE GROUP ----
    if (action === 'create_group') {
      const name = (p.name || '').trim().slice(0, 80);
      const type = TYPES.includes(p.type) ? p.type : 'family';
      if (!name) return err('Group name required');
      const invite = crypto.randomBytes(8).toString('hex'); // 16-char unguessable code
      const g = await req('POST', host, '/rest/v1/groups', { ...SVC(), 'Prefer': 'return=representation' },
        { name, type, owner_user_id: userId, invite_code: invite });
      const group = Array.isArray(g.body) ? g.body[0] : g.body;
      if (!group || !group.id) return err('Create failed', 500);
      await req('POST', host, '/rest/v1/group_members', { ...SVC(), 'Prefer': 'return=minimal' },
        { group_id: group.id, user_id: userId, role: 'admin' });
      audit(userId, 'group_create', 'groups', type);
      return finish({ group: { id: group.id, name: group.name, type: group.type, role: 'admin', invite_code: invite } });
    }

    // ---- LIST MY GROUPS ----
    if (action === 'list_my_groups') {
      const m = await req('GET', host, `/rest/v1/group_members?user_id=eq.${encodeURIComponent(userId)}&select=group_id,role`, SVC(), null);
      if (!Array.isArray(m.body) || m.body.length === 0) return ok({ groups: [] });
      const byId = {}; m.body.forEach(r => byId[r.group_id] = r.role);
      const ids = Object.keys(byId);
      const g = await req('GET', host, `/rest/v1/groups?id=in.(${ids.map(encodeURIComponent).join(',')})&select=id,name,type,invite_code,owner_user_id`, SVC(), null);
      const groups = (Array.isArray(g.body) ? g.body : []).map(x => ({
        id: x.id, name: x.name, type: x.type, role: byId[x.id],
        // invite_code only revealed to admins
        invite_code: byId[x.id] === 'admin' ? x.invite_code : null
      }));
      return finish({ groups });
    }

    // ---- JOIN GROUP (by invite code) ----
    if (action === 'join_group') {
      const code = (p.invite_code || '').trim();
      if (!code) return err('Invite code required');
      const g = await req('GET', host, `/rest/v1/groups?invite_code=eq.${encodeURIComponent(code)}&select=id,name,type&limit=1`, SVC(), null);
      const group = Array.isArray(g.body) && g.body[0];
      if (!group) return err('Invalid invite code', 404);
      // idempotent: upsert membership
      await req('POST', host, '/rest/v1/group_members', { ...SVC(), 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        { group_id: group.id, user_id: userId, role: 'member' });
      audit(userId, 'group_join', 'group_members', group.type);
      return finish({ group: { id: group.id, name: group.name, type: group.type, role: 'member' } });
    }

    // ---- LEAVE GROUP ----
    if (action === 'leave_group') {
      const gid = (p.group_id || '').trim();
      if (!gid) return err('group_id required');
      await req('DELETE', host, `/rest/v1/group_members?group_id=eq.${encodeURIComponent(gid)}&user_id=eq.${encodeURIComponent(userId)}`, { ...SVC(), 'Prefer': 'return=minimal' }, null);
      audit(userId, 'group_leave', 'group_members', null);
      return finish({ left: true });
    }

    // ---- POST GROUP NOTE (shared memory, scope='group') ----
    if (action === 'post_group_note') {
      const gid = (p.group_id || '').trim();
      const text = (p.text || '').trim().slice(0, 1000);
      if (!gid || !text) return err('group_id and text required');
      // verify membership server-side before writing a shared note
      const mem = await req('GET', host, `/rest/v1/group_members?group_id=eq.${encodeURIComponent(gid)}&user_id=eq.${encodeURIComponent(userId)}&select=user_id&limit=1`, SVC(), null);
      if (!Array.isArray(mem.body) || mem.body.length === 0) return err('Not a member of this group', 403);
      // embed for semantic retrieval (best-effort)
      let embedding = null;
      try {
        const e = await req('POST', 'api.openai.com', '/v1/embeddings', { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` }, { model: 'text-embedding-3-small', input: text });
        if (!e.body.error) embedding = e.body.data[0].embedding;
      } catch(e) {}
      const row = { user_id: userId, content: text, memory_type: 'group_note', session_date: new Date().toISOString().split('T')[0], scope: 'group', group_id: gid };
      if (embedding) row.embedding = embedding;
      await req('POST', host, '/rest/v1/memories', { ...SVC(), 'Prefer': 'return=minimal' }, row);
      audit(userId, 'group_note', 'memories', null);
      return finish({ posted: true });
    }

    return err('Unknown action');
  } catch(e) {
    console.error('[groups]', e.message);
    return err('Server error: ' + e.message, 500);
  }
};
