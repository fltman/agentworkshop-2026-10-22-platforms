'use strict';
// Team pisak: NodeLink gateway (module B). Mounted at /t/pisak/. Contract: projects/pisak/CONTRACT.md.
// Plain Node, no dependencies. Every timer callback is guarded: this process hosts every team's plugin.

const { Gateway } = require('./gateway');

const MAX_BODY = 1 << 20;
const TICK_MS = 250;
const SSE_PING_MS = 15000;

const gw = new Gateway('a');
let timer = null;

function send(res, out) {
  if (res.headersSent) return;
  res.writeHead(out.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(out.headers || {}) });
  res.end(JSON.stringify(out.body));
}

function readJson(req) {
  return new Promise(resolve => {
    let size = 0, tooBig = false;
    const chunks = [];
    req.on('data', c => {
      if (tooBig) return;
      size += c.length;
      if (size > MAX_BODY) { tooBig = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return resolve({ error: `body larger than ${MAX_BODY} bytes` });
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({ value: null });
      try { resolve({ value: JSON.parse(text) }); } catch { resolve({ error: 'body is not valid JSON' }); }
    });
    req.on('error', err => resolve({ error: `could not read body: ${err && err.message}` }));
  });
}

const badRequest = msg => ({ status: 400, body: { error: { code: 'BAD_PROTOCOL', reason: null, at: 'gateway', message: msg }, correlationId: null } });

const POST_ROUTES = {
  '/api/register': (req, body) => gw.register(body),
  '/api/heartbeat': (req, body) => gw.heartbeat(req, body),
  '/api/deregister': (req, body) => gw.deregister(req, body),
  '/api/route': (req, body) => gw.route(req, body),
  '/api/admin': (req, body) => gw.admin(body),
};

function info() {
  return {
    status: 200,
    body: {
      service: 'NodeLink gateway', team: 'pisak', contract: 'v0.3', gateway: gw.id, status: gw.status,
      endpoints: ['POST /api/register', 'POST /api/heartbeat', 'POST /api/deregister', 'GET /api/nodes', 'POST /api/route',
        'GET /api/state', 'GET /api/metrics', 'GET /api/events?since=<seq>&limit=<n>', 'GET /api/events/stream', 'POST /api/admin'],
    },
  };
}

module.exports = {
  init() {
    if (timer) return;
    let lastPing = Date.now();
    timer = setInterval(() => {
      try {
        gw.tick();
        if (Date.now() - lastPing >= SSE_PING_MS) { lastPing = Date.now(); gw.events.ping(); }
      } catch (err) {
        console.error('[pisak] tick:', err && err.message);
      }
    }, TICK_MS);
    if (timer.unref) timer.unref();
  },

  async handle(req, res, ctx) {
    if (!gw.baseUrl && req.socket && req.socket.localPort) gw.baseUrl = `http://127.0.0.1:${req.socket.localPort}`;
    const path = (ctx.path || '/').replace(/\/+$/, '') || '/';
    const url = ctx.url || new URL(req.url, 'http://x');

    if (POST_ROUTES[path]) {
      if (req.method !== 'POST') { send(res, { ...badRequest(`use POST for ${path}`), status: 405 }); return true; }
      const { value, error } = await readJson(req);
      send(res, error ? badRequest(error) : await POST_ROUTES[path](req, value));
      return true;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    switch (path) {
      case '/':
      case '/api': send(res, info()); return true;
      case '/api/nodes': send(res, gw.listNodes(req)); return true;
      case '/api/state': send(res, { status: 200, body: gw.state() }); return true;
      case '/api/metrics': send(res, { status: 200, body: gw.metrics.full() }); return true;
      case '/api/events': {
        const since = url.searchParams.has('since') ? Number(url.searchParams.get('since')) : NaN;
        const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 200));
        send(res, { status: 200, body: gw.events.page(since, limit) });
        return true;
      }
      case '/api/events/stream': {
        const from = req.headers['last-event-id'] || url.searchParams.get('since');
        gw.events.subscribe(req, res, from ? Number(from) : NaN);
        return true;
      }
      default: return false;
    }
  },

  _gateway: gw, // for tests
};
