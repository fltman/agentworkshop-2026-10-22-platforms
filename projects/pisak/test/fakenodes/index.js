'use strict';
// Test double for farzad's nodes (projects/farzad/CONTRACT.md section 3). Only used by test/gateway.test.mjs.
//   POST /t/fakenodes/n/<id>/deliver    echo answers requests; sink accepts oneway/broadcast
//   POST /t/fakenodes/n/<id>/heartbeat  200 unless killed
//   POST /t/fakenodes/chaos             {nodeId, killed?, delayMs?, fail503?, failWith?: {status, code}, state?, redirect?}
//                                       redirect: '<otherId>' answers every call with 307 to the same call on that node
//   GET  /t/fakenodes/received          what each node received

const chaos = new Map();
const received = new Map();
const held = new Set();
const get = id => chaos.get(id) || { killed: false, delayMs: 0, fail503: false, failWith: null, state: 'up' };

function json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }
function body(req) {
  return new Promise(resolve => {
    const c = []; req.on('data', d => c.push(d));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(c).toString() || 'null')); } catch { resolve(null); } });
  });
}
const wait = ms => new Promise(r => setTimeout(r, ms));

module.exports = {
  async handle(req, res, { path }) {
    if (path === '/chaos' && req.method === 'POST') {
      const b = await body(req);
      chaos.set(b.nodeId, { ...get(b.nodeId), ...b });
      if (!get(b.nodeId).killed) for (const r of held) { r.destroy(); held.delete(r); }
      json(res, 200, { ok: true });
      return true;
    }
    if (path === '/received') { json(res, 200, Object.fromEntries(received)); return true; }

    const m = /^\/n\/([^/]+)\/(deliver|heartbeat)$/.exec(path);
    if (!m || req.method !== 'POST') return false;
    const [, nodeId, what] = m;
    const env = await body(req);
    const c = get(nodeId);
    if (c.killed) { held.add(res); res.on('close', () => held.delete(res)); return true; } // silent: never answers
    if (c.delayMs) await wait(c.delayMs);
    if (c.redirect) { res.writeHead(307, { location: `http://${req.headers.host}/t/fakenodes/n/${c.redirect}/${what}` }); res.end(); return true; }
    if (what === 'heartbeat') { json(res, 200, { nodeId, seq: env && env.seq, receivedTs: Date.now(), ts: Date.now(), state: c.state || 'up' }); return true; }
    if (c.fail503) { json(res, 503, { error: { code: 'NODE_UNAVAILABLE', message: 'injected' }, correlationId: env && env.messageId }); return true; }
    if (c.failWith) { json(res, c.failWith.status, { error: { code: c.failWith.code, at: nodeId, message: 'injected' }, correlationId: env && env.messageId }); return true; }

    if (!received.has(nodeId)) received.set(nodeId, []);
    received.get(nodeId).push({ messageId: env.messageId, type: env.type, attempt: req.headers['x-nodelink-attempt'] });
    if (env.type === 'request') {
      json(res, 200, {
        messageId: env.messageId + '-r', type: 'response', source: env.destination, destination: env.source,
        timestamp: Date.now(), correlationId: env.messageId, payload: env.payload,
      });
    } else {
      json(res, 202, { accepted: true });
    }
    return true;
  },
};
