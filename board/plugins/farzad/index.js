'use strict';
// Team farzad: the Node module (CONTRACT.md). Thin HTTP router over lib/.
const path = require('path');
const E = require(path.join(__dirname, 'lib', 'envelope.js'));
const { Cluster, MAX_NODES, guard } = require(path.join(__dirname, 'lib', 'cluster.js'));
const { Sender } = require(path.join(__dirname, 'lib', 'sender.js'));
const { INFLIGHT_LIMIT } = require(path.join(__dirname, 'lib', 'node.js'));

const BODY_CAP = 1 << 20;
const HOLD_MS = 30000;
const log = (...a) => console.error('[farzad]', ...a);

let cluster = null;
let sender = null;

function setup() {
  if (cluster) return;
  cluster = new Cluster();
  sender = new Sender(cluster);
  cluster.sender = sender;
  cluster.start();
  cluster.reset(5, 'mesh');
}

function send(res, status, obj) {
  if (res.headersSent || res.destroyed) return;
  const data = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(data);
}
const fail = (res, err) => send(res, E.statusOf(err), { error: err, correlationId: null });
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });

// Reads the raw body, keeping at most BODY_CAP bytes. Resolves {buf, size}.
function readRaw(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size <= BODY_CAP) chunks.push(c); });
    req.on('end', () => resolve({ buf: Buffer.concat(chunks), size }));
    req.on('error', () => resolve({ buf: Buffer.alloc(0), size: 0, broken: true }));
  });
}

async function readJson(req) {
  const { buf, size } = await readRaw(req);
  if (size > BODY_CAP) return { tooLarge: true };
  if (!buf.length) return { body: {} };
  try { return { body: JSON.parse(buf.toString('utf8')) }; } catch { return { invalid: true }; }
}

// Chaos on the receiving side: a down node answers nobody, drop holds the request, slow delays it.
// Returns false when the request must not be answered.
async function receiveChaos(n, req, res) {
  if (n.status === 'down' || n.status === 'restarting') { req.socket.destroy(); return false; }
  if (n.chaos.dropPercent > 0 && Math.random() * 100 < n.chaos.dropPercent) {
    req.resume();
    const t = setTimeout(() => { try { req.socket.destroy(); } catch (e) { log(e && e.message); } }, HOLD_MS);
    if (t.unref) t.unref();
    res.on('close', () => clearTimeout(t));
    return false;
  }
  if (n.chaos.delayMs > 0) await sleep(n.chaos.delayMs);
  if (n.status !== 'up' && n.status !== 'leaving') { req.socket.destroy(); return false; }
  return true;
}

async function nodeEndpoint(req, res, nodeId, what) {
  const n = cluster.nodes.get(nodeId);
  if (!n) { fail(res, E.error('UNKNOWN_NODE', 'node', `no node ${nodeId}`)); return; }
  if (what === 'deliver') {
    if (n.status === 'down' || n.status === 'restarting') { req.socket.destroy(); return; }
    // Messages held by slow chaos are in flight at this node too, so they count towards PEER_OVERLOADED.
    if (n.inflight >= INFLIGHT_LIMIT) {
      const { buf } = await readRaw(req);
      let correlationId = null;
      try { const id = JSON.parse(buf.toString('utf8')).messageId; if (typeof id === 'string') correlationId = id; } catch { /* not JSON */ }
      send(res, 503, { error: E.error('PEER_OVERLOADED', n.id, `${n.inflight} messages in flight`), correlationId });
      return;
    }
    n.inflight += 1;
    try { await receiveDeliver(n, req, res); } finally { n.inflight -= 1; }
    return;
  }
  if (!(await receiveChaos(n, req, res))) return;
  const receivedTs = n.now();
  let body = null;
  try { body = JSON.parse((await readRaw(req)).buf.toString('utf8') || '{}'); } catch { /* bad body */ }
  if (!body || typeof body !== 'object') { fail(res, E.error('BAD_PROTOCOL', n.id, 'heartbeat body must be JSON')); return; }
  cluster.onHeartbeat(n, body);
  send(res, 200, n.heartbeatAnswer(body, receivedTs));
}

async function receiveDeliver(n, req, res) {
  if (!(await receiveChaos(n, req, res))) return;
  const { buf, size } = await readRaw(req);
  if (size > E.MAX_BYTES) { fail(res, E.error('MESSAGE_TOO_LARGE', n.id, `envelope is ${size} bytes, max ${E.MAX_BYTES}`)); return; }
  let env;
  try { env = JSON.parse(buf.toString('utf8')); } catch { fail(res, E.error('BAD_PROTOCOL', n.id, 'envelope is not JSON')); return; }
  const r = await n.deliver(env);
  send(res, r.status, r.body);
}

async function api(req, res, p, url) {
  const m = req.method;
  const parts = p.split('/').filter(Boolean);
  if (m === 'GET' && p === '/api/state') return send(res, 200, cluster.state());
  if (m === 'GET' && p === '/api/events') return send(res, 200, cluster.events.page(url.searchParams.get('since')));
  if (parts[1] === 'requests' && parts.length === 3) {
    if (m === 'GET') { const r = sender.get(parts[2]); return r ? send(res, 200, r) : send(res, 404, { error: { message: `no request ${parts[2]}` } }); }
    if (m === 'DELETE') { const r = sender.abort(parts[2]); return send(res, r.status, r.body); }
  }
  if (m === 'DELETE' && parts[1] === 'nodes' && parts.length === 3) {
    const n = cluster.nodes.get(parts[2]);
    if (!n) return fail(res, E.error('UNKNOWN_NODE', 'node', `no node ${parts[2]}`));
    const code = await cluster.removeNode(n);
    if (code === 'MIN_NODES') return fail(res, E.error('MIN_NODES', 'node', 'the cluster cannot go below 3 nodes'));
    return send(res, 200, { nodeId: n.id, removed: true });
  }
  if (m === 'DELETE' && parts[1] === 'nodes' && parts[3] === 'apps' && parts.length === 5) {
    const n = cluster.nodes.get(parts[2]);
    if (!n) return fail(res, E.error('UNKNOWN_NODE', 'node', `no node ${parts[2]}`));
    const err = n.removeApp(parts[4], url.searchParams.get('listenerId'));
    if (err) return fail(res, err);
    return send(res, 200, { nodeId: n.id, apps: n.appList() });
  }
  if (m !== 'POST') return false;
  const { body, tooLarge, invalid } = await readJson(req);
  if (tooLarge) return fail(res, E.error('MESSAGE_TOO_LARGE', 'node', 'body too large'));
  if (invalid || !body || typeof body !== 'object' || Array.isArray(body)) return fail(res, E.error('BAD_PROTOCOL', 'node', 'body must be a JSON object'));

  if (p === '/api/send') { const r = await sender.send(body); return send(res, r.status, r.body); }
  if (p === '/api/reset') {
    const count = body.nodes === undefined ? 5 : Number(body.nodes);
    const mode = body.mode === undefined ? 'mesh' : body.mode;
    if (!Number.isInteger(count) || count < 3 || count > MAX_NODES) return fail(res, E.error('BAD_PROTOCOL', 'node', `nodes must be 3 to ${MAX_NODES}`));
    if (mode !== 'mesh' && mode !== 'gateway') return fail(res, E.error('BAD_PROTOCOL', 'node', 'mode must be mesh or gateway'));
    cluster.reset(count, mode);
    return send(res, 200, { mode, nodes: [...cluster.nodes.keys()] });
  }
  if (p === '/api/nodes') {
    const count = body.count === undefined ? 1 : Number(body.count);
    if (!Number.isInteger(count) || count < 1) return fail(res, E.error('BAD_PROTOCOL', 'node', 'count must be a positive integer'));
    const r = cluster.addNodes(count, body.external === true);
    if (r.error) return send(res, 409, { error: { code: 'MAX_NODES', at: 'node', message: r.error } });
    return send(res, 201, { nodes: r.ids });
  }
  if (parts[1] === 'nodes' && parts[3] === 'apps' && parts.length === 4) {
    const n = cluster.nodes.get(parts[2]);
    if (!n) return fail(res, E.error('UNKNOWN_NODE', 'node', `no node ${parts[2]}`));
    if (typeof body.appId !== 'string' || !body.appId || body.appId === '*') return fail(res, E.error('BAD_PROTOCOL', 'node', 'appId required'));
    if (body.listenerId != null && typeof body.listenerId !== 'string') return fail(res, E.error('BAD_PROTOCOL', 'node', 'listenerId must be a string'));
    const app = n.addApp(body.appId, body.listenerId, body.msgTypes);
    return send(res, 201, { nodeId: n.id, app: { appId: app.appId, listenerIds: [...app.listenerIds], msgTypes: { ...app.msgTypes } } });
  }
  if (p === '/api/mode') {
    if (body.mode !== 'mesh' && body.mode !== 'gateway') return fail(res, E.error('BAD_PROTOCOL', 'node', 'mode must be mesh or gateway'));
    const r = await cluster.switchMode(body.mode);
    return send(res, r.status, r.body);
  }
  if (p === '/api/traffic') return send(res, 200, sender.setTraffic(body));
  if (p === '/api/chaos') {
    const n = cluster.nodes.get(body.nodeId);
    if (!n) return fail(res, E.error('UNKNOWN_NODE', 'node', `no node ${body.nodeId}`));
    const problem = cluster.chaos(n, body);
    if (problem) return fail(res, E.error('BAD_PROTOCOL', 'node', problem));
    return send(res, 200, { nodeId: n.id, status: n.status, chaos: { ...n.chaos } });
  }
  return false;
}

async function route(req, res, ctx) {
  const p = (ctx && ctx.path) || '/';
  const url = new URL(req.url, 'http://local');
  const nm = /^\/n\/([^/]+)\/(deliver|heartbeat)$/.exec(p);
  if (nm) {
    if (req.method !== 'POST') return false;
    await nodeEndpoint(req, res, nm[1], nm[2]);
    return true;
  }
  if (p === '/' && req.method === 'GET') { send(res, 200, { module: 'node', contract: '0.2', base: '/t/farzad/' }); return true; }
  if (p.startsWith('/api/')) {
    const r = await api(req, res, p, url);
    return r !== false;
  }
  return false;
}

module.exports = {
  init() { try { setup(); } catch (e) { log('init', e && e.message); } },
  async handle(req, res, ctx) {
    try {
      setup();
      return await route(req, res, ctx);
    } catch (e) {
      log('handle', e && e.message);
      send(res, 500, { error: { at: 'node', message: 'internal error' } });
      return true;
    }
  },
  shutdown() { guard(() => { if (cluster) cluster.stop(); cluster = null; sender = null; }); },
};
