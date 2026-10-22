// Stand-in gateway for local tests of the Node module. Mounted as /t/pisak/ in a scratch PLUGINS_DIR.
// Implements only what CONTRACT.md section 6 expects from the real gateway:
//   POST /api/register {nodeId, apps, deliverUrl, heartbeatUrl, external} -> {token}
//   POST /api/route   (Bearer token) envelope -> node's answer, or {delivered, failed} for a broadcast
//   POST /api/deregister {nodeId} (Bearer token)
//   GET  /api/events?since=N -> {seq, events} with {kind:"node-down", detectMs} / node.up (probes heartbeatUrl every 1 s, down after 3 s)
//   probes are {from:"gateway", ts, state, peers:{nodeId: up|slow|down}} (as pisak v0.5: never the probed node itself)
//   POST /api/admin {action: kill|revive|reset}  the gateway stops answering (503), comes back, or forgets all nodes
const http = require('http');

const PORT = Number(process.env.PORT || 8180);
const st = { nodes: new Map(), down: false, seq: 0, events: [], timer: null, routes: 0 };

function call(path, body, headers = {}, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method: 'POST', timeout: timeoutMs,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch { /* not json */ } resolve({ status: res.statusCode, body: j }); });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 504, body: null, timeout: true }); });
    req.on('error', () => resolve({ status: 503, body: null }));
    req.end(data);
  });
}

function emit(e) { st.seq += 1; st.events.push({ id: `pisak-${st.seq}`, seq: st.seq, ts: Date.now(), ok: false, latencyMs: null, errorCode: null, ...e }); if (st.events.length > 500) st.events.shift(); }
function send(res, status, obj) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); }
function err(res, status, code, reason) { send(res, status, { error: { code, reason, at: 'gateway', message: code } }); }
function readBody(req) { return new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r(null); } }); }); }
function auth(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return null;
  for (const n of st.nodes.values()) if (n.token === m[1]) return n;
  return null;
}

// Every probe carries the gateway's view of all other registered nodes (peers, additive). slow: answered, but late.
const peerStatus = (n) => (n.status === 'up' && n.rttMs > 500 ? 'slow' : n.status);
async function probe() {
  for (const n of st.nodes.values()) {
    if (!n.heartbeatUrl) continue;
    const peers = Object.fromEntries([...st.nodes.values()].filter((p) => p !== n).map((p) => [p.nodeId, peerStatus(p)]));
    const t0 = Date.now();
    const r = await call(n.heartbeatUrl, { from: 'gateway', ts: t0, state: 'up', peers }, {}, 900);
    if (r.status === 200) {
      n.lastSeen = Date.now();
      n.rttMs = n.lastSeen - t0;
      if (n.status === 'down') { n.status = 'up'; emit({ type: 'node.up', from: 'gateway', to: n.nodeId, ok: true }); }
    } else if (n.status === 'up' && Date.now() - n.lastSeen >= 3000) {
      n.status = 'down';
      emit({ kind: 'node-down', from: 'gateway', to: n.nodeId, detectMs: Date.now() - n.lastSeen, errorCode: 'NODE_UNAVAILABLE' });
    }
  }
}

module.exports = {
  init() {
    st.timer = setInterval(() => { probe().catch((e) => console.error('[fake-gateway]', e && e.message)); }, 1000);
    if (st.timer.unref) st.timer.unref();
  },
  async handle(req, res, { path }) {
    if (path === '/api/admin' && req.method === 'POST') {
      const b = (await readBody(req)) || {};
      if (b.action === 'kill') st.down = true;
      else if (b.action === 'revive') { st.down = false; st.nodes.clear(); } // registrations are lost, nodes re-register on 401
      else if (b.action === 'reset') { st.nodes.clear(); st.events.length = 0; } // a killed gateway stays killed
      else if ('down' in b) st.down = !!b.down;
      send(res, 200, { down: st.down }); return true;
    }
    if (path.startsWith('/api/events') && req.method === 'GET') {
      const since = Number(new URL(req.url, 'http://x').searchParams.get('since') || 0);
      const ev = st.events.filter((e) => e.seq > since);
      send(res, 200, { seq: ev.length ? ev[ev.length - 1].seq : since, events: ev }); return true;
    }
    if (path === '/api/state' && req.method === 'GET') { send(res, 200, { down: st.down, routes: st.routes, nodes: [...st.nodes.values()].map((n) => ({ nodeId: n.nodeId, status: n.status })) }); return true; }
    if (st.down) { err(res, 503, 'NODE_UNAVAILABLE', 'gateway_down'); return true; }
    if (req.method !== 'POST') return false;
    const body = await readBody(req);
    if (!body) { err(res, 400, 'BAD_PROTOCOL'); return true; }
    if (path === '/api/register') {
      const token = `tok-${body.nodeId}-${Math.random().toString(36).slice(2)}`;
      st.nodes.set(body.nodeId, { ...body, token, status: 'up', lastSeen: Date.now() });
      send(res, 200, { token }); return true;
    }
    const node = auth(req);
    if (!node) { err(res, 401, 'REJECTED', 'auth'); return true; }
    if (path === '/api/deregister') { st.nodes.delete(body.nodeId); send(res, 200, { ok: true }); return true; }
    if (path === '/api/route') {
      st.routes += 1;
      const d = body.destination || {};
      if (d.nodeId === '*') {
        const targets = [...st.nodes.values()].filter((n) => n.nodeId !== node.nodeId && (body.scope === 'all' || !n.external));
        const results = await Promise.all(targets.map(async (n) => ({ n, r: await call(n.deliverUrl, body, {}, body.ttlMs || 2000) })));
        const delivered = []; const failed = [];
        for (const { n, r } of results) {
          if (r.status === 202 || r.status === 200) delivered.push(n.nodeId);
          else failed.push({ nodeId: n.nodeId, code: (r.body && r.body.error && r.body.error.code) || (r.timeout ? 'TIMEOUT' : 'NODE_UNAVAILABLE') });
        }
        send(res, 200, { delivered, failed }); return true;
      }
      const target = st.nodes.get(d.nodeId);
      if (!target) { err(res, 404, 'UNKNOWN_NODE'); return true; }
      if (target.status === 'down') { err(res, 503, 'NODE_UNAVAILABLE'); return true; }
      const r = await call(target.deliverUrl, body, {}, body.ttlMs || 2000);
      if (r.timeout) { err(res, 504, 'TIMEOUT'); return true; }
      send(res, r.status, r.body || {}); return true;
    }
    return false;
  },
};
