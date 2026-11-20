// Cricket Live Server — central match database + scorer app + one separate overlay URL per match and graphic
// for OBS Browser Source / vMix Web Browser input. No dependencies: needs Node 18+.
//
// Storage (matches are kept on the SERVER, so every device sees the same matches):
//   - UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN set  -> saved in a free Upstash Redis database (survives restarts)
//   - otherwise                                              -> saved to data/db.json next to this file (good for your own computer)
// Optional: EDIT_PASSWORD=secret  -> only people who know the password can create / change / delete matches.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 4000;
const HOST = process.env.HOST || '0.0.0.0';       // set HOST=127.0.0.1 to allow this computer only
const INDEX = path.join(__dirname, 'public', 'index.html');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MAX_BODY = 5 * 1024 * 1024;
const EDIT_PASSWORD = process.env.EDIT_PASSWORD || '';
const UP_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// ---------------------------------------------------------------- in-memory copy of the database
const matches = new Map();      // id -> { ...match, rev }
let rosters = {};               // team name -> [players]
let meta = {};                  // { dbid }: identifies this database, so a device can tell when the server's data was replaced or wiped
let themes = {};                // match id -> { c1, c2, size, tpl } (set from the scorer's Broadcast tab)
let last = null;                // latest state pushed by a scoring page (used by the old "current match" overlay links)
const fieldsByMatch = new Map();// match id -> vMix field values
const clients = new Set();      // connected pages (Server-Sent Events): { res, kind, m }

// ---------------------------------------------------------------- storage back-ends
function fileStore() {
  const file = path.join(DATA_DIR, 'db.json');
  return {
    name: 'file', persistent: true,
    async load() {
      try {
        const d = JSON.parse(fs.readFileSync(file, 'utf8'));
        return { matches: d.matches || [], rosters: d.rosters || {}, themes: d.themes || {}, meta: d.meta || {} };
      } catch (e) { return { matches: [], rosters: {}, themes: {}, meta: {} }; }
    },
    async write(diff, all) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(all()));
      fs.renameSync(tmp, file);
    }
  };
}

function upstashStore() {
  const K = { meta: 'cricket:meta', ids: 'cricket:ids', ros: 'cricket:rosters', thm: 'cricket:themes', m: id => 'cricket:m:' + id };
  async function run(cmds) {
    const r = await fetch(UP_URL + '/pipeline', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + UP_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds)
    });
    if (!r.ok) throw new Error('Upstash HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const out = await r.json();
    return out.map(x => { if (x && x.error) throw new Error('Upstash: ' + x.error); return x.result; });
  }
  return {
    name: 'upstash', persistent: true,
    async load() {
      const [ids, ros, thm, met] = await run([['SMEMBERS', K.ids], ['GET', K.ros], ['GET', K.thm], ['GET', K.meta]]);
      const ms = [];
      for (let i = 0; i < (ids || []).length; i += 20) {
        const chunk = ids.slice(i, i + 20);
        const vals = await run(chunk.map(id => ['GET', K.m(id)]));
        vals.forEach(v => { if (v) { try { ms.push(JSON.parse(v)); } catch (e) { } } });
      }
      return { matches: ms, rosters: ros ? JSON.parse(ros) : {}, themes: thm ? JSON.parse(thm) : {}, meta: met ? JSON.parse(met) : {} };
    },
    async write(diff) {
      const cmds = [];
      diff.deletes.forEach(id => { cmds.push(['DEL', K.m(id)]); cmds.push(['SREM', K.ids, id]); });
      diff.matches.forEach(m => { cmds.push(['SET', K.m(m.id), JSON.stringify(m)]); cmds.push(['SADD', K.ids, m.id]); });
      if (diff.rosters) cmds.push(['SET', K.ros, JSON.stringify(diff.rosters)]);
      if (diff.themes) cmds.push(['SET', K.thm, JSON.stringify(diff.themes)]);
      if (diff.meta) cmds.push(['SET', K.meta, JSON.stringify(diff.meta)]);
      if (cmds.length) await run(cmds);
    }
  };
}

const store = (UP_URL && UP_TOKEN) ? upstashStore() : fileStore();

// Changes are saved a moment after they happen (many scoring clicks become one save). A failed save is retried.
const dirty = { m: new Set(), del: new Set(), rosters: false, themes: false, meta: false };
let flushing = false, flushTimer = null;
function markDirty() { if (!flushTimer && !flushing) flushTimer = setTimeout(flush, 400); }
async function flush() {
  flushTimer = null;
  if (flushing) return;
  flushing = true;
  const ms = [...dirty.m], ds = [...dirty.del], r = dirty.rosters, t = dirty.themes, mt = dirty.meta;
  dirty.m.clear(); dirty.del.clear(); dirty.rosters = false; dirty.themes = false; dirty.meta = false;
  try {
    await store.write(
      { matches: ms.map(id => matches.get(id)).filter(Boolean), deletes: ds, rosters: r ? rosters : null, themes: t ? themes : null, meta: mt ? meta : null },
      () => ({ matches: [...matches.values()], rosters, themes, meta })
    );
  } catch (e) {
    console.error('Saving to the database failed (will retry):', e.message);
    ms.forEach(id => dirty.m.add(id)); ds.forEach(id => dirty.del.add(id));
    if (r) dirty.rosters = true; if (t) dirty.themes = true; if (mt) dirty.meta = true;
    flushing = false; flushTimer = setTimeout(flush, 5000);
    return;
  }
  flushing = false;
  if (dirty.m.size || dirty.del.size || dirty.rosters || dirty.themes || dirty.meta) markDirty();
}

// ---------------------------------------------------------------- helpers
function json(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  // Bodies over MAX_BODY are discarded (not stored) and answered with 413 once fully received.
  return new Promise((resolve, reject) => {
    let size = 0, over = false; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 64 * MAX_BODY) { req.destroy(); return; }   // hard stop for absurd uploads
      if (size > MAX_BODY) { over = true; chunks.length = 0; return; }
      if (!over) chunks.push(c);
    });
    req.on('end', () => over ? reject(Object.assign(new Error('too large'), { code: 413 })) : resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function canWrite(req) {
  if (!EDIT_PASSWORD) return true;
  const a = Buffer.from(String(req.headers['x-edit-key'] || '')), b = Buffer.from(EDIT_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const denied = res => json(res, { error: 'Edit password required', needAuth: true }, 401);
async function bodyJson(req, res) {
  try {
    const msg = JSON.parse(await readBody(req));
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw new Error('bad');
    return msg;
  } catch (e) {
    json(res, { error: e.code === 413 ? 'Payload too large' : 'Invalid JSON' }, e.code === 413 ? 413 : 400);
    return null;
  }
}

// ---------------------------------------------------------------- live updates to pages (Server-Sent Events)
const RECENT_MS = 48 * 3600 * 1000;
const sse = (event, data) => `event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
function liveList() {
  const now = Date.now();
  return [...matches.values()]
    .filter(r => r.events && r.events.length && !r.imp && now - (r.updated || 0) < RECENT_MS)
    .sort((a, b) => (b.updated || 0) - (a.updated || 0)).slice(0, 8)
    .map(r => ({ id: r.id, events: r.events }));
}
function matchMsg(id) {
  const r = matches.get(id);
  return { v: 1, mid: id, events: r && !r.imp ? (r.events || []) : [], imp: r && r.imp ? r.imp : null, theme: themes[id] || (last && last.theme) || undefined, live: [] };
}
function pubMsg(id) {
  if (id) { const r = matches.get(id); return { v: 1, live: r && r.events && r.events.length ? [{ id, events: r.events }] : [] }; }
  return { v: 1, live: liveList() };
}
function msgFor(c) {
  if (c.kind === 'match') return matchMsg(c.m);
  if (c.kind === 'pub') return pubMsg(c.m);
  return last;                                   // old "current match" overlay
}
function send(c, event, data) { try { c.res.write(sse(event, data)); } catch (e) { clients.delete(c); } }

const touched = new Set(); let allTouched = false, bTimer = null;
function touch(id) { if (id) touched.add(id); else allTouched = true; if (!bTimer) bTimer = setTimeout(pushUpdates, 120); }
function pushUpdates() {
  bTimer = null;
  const ids = new Set(touched), all = allTouched; touched.clear(); allTouched = false;
  const cache = new Map();
  for (const c of clients) {
    if (c.kind === 'sync') continue;
    let key, msg;
    if (c.kind === 'match') { if (!all && !ids.has(c.m)) continue; key = 'm:' + c.m; }
    else if (c.kind === 'pub') { if (!all && !(c.m ? ids.has(c.m) : ids.size)) continue; key = 'p:' + (c.m || ''); }
    else { if (!all) continue; key = 'l'; }
    let s = cache.get(key);
    if (s === undefined) { msg = msgFor(c); s = msg ? sse('state', msg) : ''; cache.set(key, s); }
    if (s) { try { c.res.write(s); } catch (e) { clients.delete(c); } }
  }
}
function syncBroadcast(event, data) {
  const s = sse(event, data);
  for (const c of clients) if (c.kind === 'sync') { try { c.res.write(s); } catch (e) { clients.delete(c); } }
}

const isPage = p => p === '/' || p === '/control' || p === '/index.html'
  || /^\/overlay\/[a-z]+\/?$/.test(p) || /^\/overlay\/[A-Za-z0-9_-]+\/[a-z]+\/?$/.test(p)   // overlays: /overlay/<graphic> (old) and /overlay/<match>/<graphic>
  || /^\/live(\/[A-Za-z0-9_-]+)?\/?$/.test(p);                                                // public live pages

// ---------------------------------------------------------------- HTTP server
const server = http.createServer(async (req, res) => {
  let u; try { u = new URL(req.url, 'http://localhost'); } catch (e) { res.writeHead(400); return res.end(); }
  const p = u.pathname;

  if (p === '/api/health') return json(res, { cricket: true, overlays: clients.size, hasMatch: matches.size > 0, matches: matches.size, store: store.name, persistent: store.persistent, locked: !!EDIT_PASSWORD, central: true });

  if (p === '/api/stream') {
    const q = u.searchParams;
    const c = { res, kind: q.get('sync') ? 'sync' : q.get('pub') ? 'pub' : q.get('m') ? 'match' : 'legacy', m: ID_RE.test(q.get('m') || '') ? q.get('m') : '' };
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 1000\n\n');
    clients.add(c);
    const first = msgFor(c);
    if (first) res.write(sse('state', first));
    const ka = setInterval(() => { try { res.write(': keepalive\n\n'); } catch (e) { clearInterval(ka); } }, 15000);
    req.on('close', () => { clearInterval(ka); clients.delete(c); });
    return;
  }

  // ---- central database: list / read matches
  if (p === '/api/matches' && req.method === 'GET') return json(res, { matches: [...matches.values()], rosters, dbid: meta.dbid });
  let mm = p.match(/^\/api\/matches\/([A-Za-z0-9_-]{1,64})$/);
  if (mm) {
    const id = mm[1];
    if (req.method === 'GET') return matches.has(id) ? json(res, matches.get(id)) : json(res, { error: 'Not found' }, 404);
    if (req.method === 'PUT') {
      if (!canWrite(req)) return denied(res);
      const body = await bodyJson(req, res); if (!body) return;
      const m = body.match;
      if (!m || typeof m !== 'object' || Array.isArray(m) || m.id !== id) return json(res, { error: 'Invalid match' }, 400);
      if (m.events !== undefined && !Array.isArray(m.events)) return json(res, { error: 'Invalid match' }, 400);
      const ex = matches.get(id);
      // Someone else saved this match after the copy this device last saw: send back the newer copy so the device can merge.
      if (ex && body.base !== ex.rev) return json(res, { conflict: true, match: ex }, 409);
      const rec = Object.assign({}, m, { id, rev: (ex ? ex.rev : 0) + 1 });
      matches.set(id, rec); dirty.m.add(id); dirty.del.delete(id); markDirty();
      syncBroadcast('match', { match: rec, sid: body.sid || '' });
      touch(id);
      return json(res, { ok: true, rev: rec.rev });
    }
    if (req.method === 'DELETE') {
      if (!canWrite(req)) return denied(res);
      if (!matches.has(id)) return json(res, { ok: true, gone: true });
      matches.delete(id); delete themes[id]; fieldsByMatch.delete(id);
      dirty.del.add(id); dirty.m.delete(id); dirty.themes = true; markDirty();
      syncBroadcast('matchdel', { id, sid: String(req.headers['x-sid'] || '') });
      touch(id);
      return json(res, { ok: true });
    }
  }
  if (p === '/api/rosters' && req.method === 'POST') {
    if (!canWrite(req)) return denied(res);
    const body = await bodyJson(req, res); if (!body) return;
    if (body.set && typeof body.set === 'object') Object.entries(body.set).forEach(([t, a]) => { if (Array.isArray(a)) rosters[String(t).slice(0, 80)] = a.map(x => String(x).slice(0, 80)); });
    if (Array.isArray(body.del)) body.del.forEach(t => { delete rosters[t]; });
    dirty.rosters = true; markDirty();
    syncBroadcast('rosters', { rosters, sid: body.sid || '' });
    return json(res, { ok: true });
  }

  // ---- the scoring page pushes display settings (and, for the old links, the whole current state) here
  if (p === '/api/state' && req.method === 'POST') {
    if (!canWrite(req)) return denied(res);
    const msg = await bodyJson(req, res); if (!msg) return;
    // Ignore an update that is older than the one already held from the same scoring page (guards against out-of-order delivery).
    if (last && last.sid && msg.sid === last.sid && typeof msg.seq === 'number' && typeof last.seq === 'number' && msg.seq <= last.seq)
      return json(res, { ok: true, stale: true, overlays: clients.size });
    last = msg;
    if (typeof msg.mid === 'string' && ID_RE.test(msg.mid) && matches.has(msg.mid)) {
      if (msg.fields) fieldsByMatch.set(msg.mid, msg.fields);
      if (msg.theme && JSON.stringify(themes[msg.mid]) !== JSON.stringify(msg.theme)) { themes[msg.mid] = msg.theme; dirty.themes = true; markDirty(); touch(msg.mid); }
    }
    touch(null);   // old-style overlays follow the most recent scoring page
    return json(res, { ok: true, overlays: clients.size });
  }

  // Live values for vMix Data Sources / other tools (JSON). Add ?m=<match id> for one match.
  if (p === '/api/fields.json') {
    const id = u.searchParams.get('m');
    return json(res, (id ? fieldsByMatch.get(id) : last && last.fields) || {});
  }

  if (isPage(p) && (req.method === 'GET' || req.method === 'HEAD')) {
    fs.readFile(INDEX, (err, buf) => {
      if (err) { res.writeHead(500); return res.end('public/index.html is missing'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : buf);
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
});

// ---------------------------------------------------------------- start
async function start() {
  try {
    const d = await store.load();
    d.matches.forEach(m => { if (m && ID_RE.test(m.id || '')) matches.set(m.id, Object.assign({}, m, { rev: m.rev || 1 })); });
    rosters = d.rosters || {}; themes = d.themes || {}; meta = d.meta || {};
    if (!meta.dbid) { meta.dbid = crypto.randomBytes(6).toString('hex'); dirty.meta = true; markDirty(); }
    console.log('\nDatabase: ' + store.name + (store.name === 'upstash' ? ' (online)' : ' (' + path.join(DATA_DIR, 'db.json') + ')') + ' — ' + matches.size + ' match(es) loaded');
  } catch (e) {
    console.error('\nCould not load the database: ' + e.message);
    console.error('Check UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN. Not starting, so nothing is overwritten.\n');
    process.exit(1);
  }
  server.listen(PORT, HOST, () => {
    const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
    console.log('\nCricket Live Server is running\n');
    console.log('  Scoring page (open on any device):');
    console.log('    http://localhost:' + PORT + '/');
    ips.forEach(ip => console.log('    http://' + ip + ':' + PORT + '/   (other devices on this network)'));
    console.log('\n  Every match has its own overlay links — open the match, then the Broadcast tab. Example:');
    console.log('    http://' + (ips[0] || 'localhost') + ':' + PORT + '/overlay/<match id>/scoreboard\n');
    if (store.name === 'file' && !process.env.RENDER) console.log('  Matches are saved in ' + DATA_DIR + ' (set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to keep them online instead).\n');
    if (store.name === 'file' && process.env.RENDER) console.log('  WARNING: no online database is set. On Render\'s free plan this disk is wiped on every restart, so matches would be lost. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.\n');
    if (EDIT_PASSWORD) console.log('  Edit password is ON.\n');
    else console.log('  Note: no EDIT_PASSWORD is set, so anyone with the link can create, change or delete matches.\n');
    if (HOST === '0.0.0.0') console.log('  Note: anyone on your network can reach this server. Use it on a trusted network, or start with HOST=127.0.0.1 for this computer only.\n');
  });
}
async function shutdown() { try { if (flushTimer) clearTimeout(flushTimer); await flush(); } catch (e) { } process.exit(0); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
start();
