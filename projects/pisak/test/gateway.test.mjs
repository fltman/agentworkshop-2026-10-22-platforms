// Integration test for the pisak gateway plugin against fake nodes, on a real board server.
// Run from the repo root: node projects/pisak/test/gateway.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pisak-gw-'));
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
let server, logs = '';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function call(method, p, body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json, headers: res.headers };
}
const post = (p, b, t) => call('POST', p, b, t);
const get = (p, t) => call('GET', p, undefined, t);
const admin = b => post('/t/pisak/api/admin', b);
const chaos = b => post('/t/fakenodes/chaos', b);

let n = 0;
const env = (from, to, extra = {}) => ({
  proto: 'nodelink', version: 2, messageId: `${from}-${++n}`, type: 'request', source: { nodeId: from, appId: 'echo', listenerId: null },
  destination: { nodeId: to, appId: 'echo', listenerId: null }, timestamp: Date.now(), payload: { n }, ...extra,
});
async function register(nodeId, apps = ['echo', 'sink'], extra = {}) {
  const r = await post('/t/pisak/api/register', { nodeId, apps, deliverUrl: `/t/fakenodes/n/${nodeId}/deliver`, ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.token;
}
async function waitFor(fn, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(50); }
  throw new Error('waitFor timed out');
}
async function fresh(config = {}) {
  await admin({ action: 'revive' });
  await admin({ action: 'reset' });
  for (const id of ['n1', 'n2', 'n3', 'x1']) await chaos({ nodeId: id, killed: false, delayMs: 0, fail503: false, failWith: null, state: 'up' });
  if (Object.keys(config).length) assert.equal((await admin({ action: 'config', config })).status, 200);
}

before(async () => {
  const plugins = path.join(tmp, 'plugins');
  fs.cpSync(path.join(root, 'board/plugins/pisak'), path.join(plugins, 'pisak'), { recursive: true });
  fs.cpSync(path.join(here, 'fakenodes'), path.join(plugins, 'fakenodes'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'colony'));
  server = spawn(process.execPath, [path.join(root, 'board/server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: path.join(tmp, 'data'), PLUGINS_DIR: plugins, COLONY_DIR: path.join(tmp, 'colony') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', d => { logs += d; });
  server.stderr.on('data', d => { logs += d; });
  await waitFor(async () => { try { return (await fetch(BASE + '/api/health')).ok; } catch { return false; } }, 10000);
});

after(() => {
  server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
  if (/\[pisak\]/.test(logs)) console.log('server log:\n' + logs);
});

test('info and bad input never crash the plugin', async () => {
  await fresh();
  assert.equal((await get('/t/pisak/')).body.team, 'pisak');
  assert.equal((await post('/t/pisak/api/route', '{not json')).status, 400);
  assert.equal((await post('/t/pisak/api/register', 'null')).status, 400);
  for (const bad of ['http://evil.example/', '/t/../api/post', '/t/x/%2e%2e/%2e%2e/api/post', '/t//api', '/t/pisak/api/route', '/api/post']) {
    assert.equal((await post('/t/pisak/api/register', { nodeId: 'x', apps: ['echo'], deliverUrl: bad })).status, 400, bad);
  }
  assert.equal((await post('/t/pisak/api/register', { nodeId: 'x', apps: ['echo'], deliverUrl: '/t/fakenodes/n/x/deliver', heartbeatUrl: '/t/a/./b' })).status, 400);
  assert.equal((await get('/t/pisak/api/register')).status, 405);
  assert.equal((await get('/t/pisak/nope')).status, 404);
  assert.equal((await post('/t/pisak/api/admin', { action: 'explode' })).status, 400);
  assert.equal((await admin({ action: 'config', config: { retries: 99 } })).status, 400);
});

test('register, auth and node listing', async () => {
  await fresh();
  const t1 = await register('n1');
  const t2 = await register('n2');
  assert.match(t1, /^gw-tok-[0-9a-f]{32}$/);
  assert.equal((await get('/t/pisak/api/nodes')).status, 401);
  const list = await get('/t/pisak/api/nodes', t1);
  assert.deepEqual(list.body.nodes.map(x => x.nodeId).sort(), ['n1', 'n2']);
  assert.equal((await post('/t/pisak/api/heartbeat', { nodeId: 'n1' }, t2)).status, 401);
  assert.equal((await post('/t/pisak/api/heartbeat', { nodeId: 'n1' }, t1)).status, 200);
  const spoof = await post('/t/pisak/api/route', env('n2', 'n1'), t1);
  assert.equal(spoof.status, 401);
  assert.equal(spoof.body.error.code, 'REJECTED');
  assert.equal(spoof.body.error.reason, 'auth');
  assert.equal((await post('/t/pisak/api/deregister', { nodeId: 'n2' }, t2)).status, 200);
  assert.equal((await get('/t/pisak/api/nodes', t1)).body.nodes.length, 1);
});

test('request, oneway, unknown node/app, broadcast', async () => {
  await fresh();
  const t1 = await register('n1');
  await register('n2');
  await register('n3', ['sink']);

  const e = env('n1', 'n2');
  const r = await post('/t/pisak/api/route', e, t1);
  assert.equal(r.status, 200);
  assert.equal(r.body.type, 'response');
  assert.equal(r.body.correlationId, e.messageId);
  assert.deepEqual(r.body.payload, e.payload);

  const ow = await post('/t/pisak/api/route', env('n1', 'n2', { type: 'oneway' }), t1);
  assert.equal(ow.status, 202);
  assert.equal(ow.body.accepted, true);

  const un = await post('/t/pisak/api/route', env('n1', 'n9'), t1);
  assert.equal(un.status, 404);
  assert.equal(un.body.error.code, 'UNKNOWN_NODE');
  assert.ok(un.body.correlationId);
  const ua = await post('/t/pisak/api/route', env('n1', 'n3'), t1);
  assert.equal(ua.body.error.code, 'UNKNOWN_APP');

  const bc = await post('/t/pisak/api/route', { ...env('n1', '*', { type: 'broadcast' }), destination: { nodeId: '*', appId: 'sink' } }, t1);
  assert.equal(bc.status, 202);
  assert.deepEqual(bc.body.delivered.sort(), ['n2', 'n3']);
  assert.deepEqual(bc.body.failed, []);
  const got = (await get('/t/fakenodes/received')).body;
  assert.ok(got.n3.some(m => m.messageId === bc.body.messageId));
  assert.ok(!(got.n1 || []).some(m => m.messageId === bc.body.messageId), 'sender must not get its own broadcast');
});

test('rate limit answers 429 REJECTED with retry-after', async () => {
  await fresh({ rateLimitPerSec: 2, rateLimitBurst: 3 });
  const t1 = await register('n1');
  await register('n2');
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await post('/t/pisak/api/route', env('n1', 'n2', { type: 'oneway' }), t1)).status);
  assert.deepEqual(codes.slice(0, 3), [202, 202, 202]);
  const r = await post('/t/pisak/api/route', env('n1', 'n2', { type: 'oneway' }), t1);
  assert.equal(r.status, 429);
  assert.equal(r.body.error.reason, 'rate_limit');
  assert.ok(Number(r.headers.get('retry-after')) >= 1);
  assert.ok((await get('/t/pisak/api/metrics')).body.rateLimited >= 1);
});

test('slow node gives TIMEOUT within ttl', async () => {
  await fresh({ retries: 0 });
  const t1 = await register('n1');
  await register('n2');
  await chaos({ nodeId: 'n2', delayMs: 800 });
  const t0 = Date.now();
  const r = await post('/t/pisak/api/route', env('n1', 'n2', { ttlMs: 300 }), t1);
  assert.equal(r.status, 504);
  assert.equal(r.body.error.code, 'TIMEOUT');
  assert.ok(Date.now() - t0 < 700, 'answered within ttl');
});

test('retries a 503 and the breaker opens, half-opens and closes', async () => {
  await fresh({ retries: 1, breakerFailures: 2, breakerOpenMs: 300 });
  const t1 = await register('n1');
  await register('n2');
  await chaos({ nodeId: 'n2', fail503: true });
  for (let i = 0; i < 2; i++) {
    const r = await post('/t/pisak/api/route', env('n1', 'n2'), t1);
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, 'NODE_UNAVAILABLE');
  }
  assert.ok((await get('/t/pisak/api/metrics')).body.retries >= 2);
  let s = await get('/t/pisak/api/state');
  assert.equal(s.body.nodes.find(x => x.nodeId === 'n2').circuit, 'open');
  const fast = await post('/t/pisak/api/route', env('n1', 'n2'), t1);
  assert.equal(fast.body.error.reason, 'circuit_open');

  await chaos({ nodeId: 'n2', fail503: false });
  await sleep(350);
  const ok = await post('/t/pisak/api/route', env('n1', 'n2'), t1);
  assert.equal(ok.status, 200);
  s = await get('/t/pisak/api/state');
  assert.equal(s.body.nodes.find(x => x.nodeId === 'n2').circuit, 'closed');
  const kinds = (await get('/t/pisak/api/events?limit=200')).body.events.map(e => e.kind);
  for (const k of ['circuit-open', 'circuit-half-open', 'circuit-closed']) assert.ok(kinds.includes(k), k);
});

test('probes detect a silent node and see it come back', async () => {
  await fresh({ probeIntervalMs: 200, probeTimeoutMs: 600 });
  await register('n1');
  await register('n2');
  await sleep(400);
  const since = (await get('/t/pisak/api/events?limit=1')).body.seq;
  await chaos({ nodeId: 'n2', killed: true });
  const down = await waitFor(async () => (await get(`/t/pisak/api/events?since=${since}`)).body.events.find(e => e.kind === 'node-down'));
  assert.equal(down.nodeId, 'n2');
  assert.equal(down.mode, 'gateway');
  assert.ok(down.detectMs >= 600 && down.detectMs < 1500, `detectMs ${down.detectMs}`);
  const s = await get('/t/pisak/api/state');
  assert.equal(s.body.nodes.find(x => x.nodeId === 'n2').status, 'down');
  assert.equal(s.body.nodes.find(x => x.nodeId === 'n1').status, 'up');
  assert.equal(s.body.metrics.detectMs, down.detectMs);

  await chaos({ nodeId: 'n2', killed: false });
  await waitFor(async () => (await get(`/t/pisak/api/events?since=${down.seq}`)).body.events.find(e => e.kind === 'node-up' && e.nodeId === 'n2'));
});

test('kill and revive the gateway', async () => {
  await fresh();
  const t1 = await register('n1');
  await register('n2');
  assert.equal((await admin({ action: 'kill' })).body.state.gateway.status, 'down');
  const r = await post('/t/pisak/api/route', env('n1', 'n2'), t1);
  assert.equal(r.status, 503);
  assert.equal(r.body.error.reason, 'gateway_down');
  assert.equal((await post('/t/pisak/api/register', { nodeId: 'n1', apps: ['echo'], deliverUrl: '/t/fakenodes/n/n1/deliver' })).status, 503);
  assert.equal((await admin({ action: 'reset' })).body.state.gateway.status, 'down', 'reset does not revive a killed gateway');
  assert.equal((await post('/t/pisak/api/register', { nodeId: 'n1', apps: ['echo'], deliverUrl: '/t/fakenodes/n/n1/deliver' })).status, 503);
  assert.equal((await admin({ action: 'revive' })).body.state.gateway.status, 'up');
  assert.equal((await post('/t/pisak/api/heartbeat', { nodeId: 'n1' }, t1)).status, 401, 'nodes re-register after revive');
  const t1b = await register('n1');
  await register('n2');
  const routesBefore = (await get('/t/pisak/api/state')).body.routes;
  assert.equal((await post('/t/pisak/api/route', env('n1', 'n2'), t1b)).status, 200);
  assert.equal((await admin({ action: 'reset' })).body.state.routes, routesBefore + 1, 'routes counts across reset');
});

test('state, metrics, events page and SSE stream share one event shape', async () => {
  await fresh();
  const t1 = await register('n1');
  await register('n2');
  const ac = new AbortController();
  const res = await fetch(BASE + '/t/pisak/api/events/stream', { signal: ac.signal });
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  await post('/t/pisak/api/route', env('n1', 'n2'), t1);
  let text = '';
  const end = Date.now() + 3000;
  while (!/event: message/.test(text) && Date.now() < end) text += new TextDecoder().decode((await reader.read()).value);
  ac.abort();
  const line = text.split('\n').find(l => l.startsWith('data:') && l.includes('"kind":"message"'));
  const ev = JSON.parse(line.slice(5));
  for (const k of ['seq', 'id', 'ts', 'kind', 'mode', 'from', 'to', 'ok', 'latencyMs', 'errorCode']) assert.ok(k in ev, k);
  assert.equal(ev.ok, true);

  const m = (await get('/t/pisak/api/metrics')).body;
  for (const k of ['p50Ms', 'p95Ms', 'throughputPerSec', 'errorRate', 'detectMs', 'routed', 'errors']) assert.ok(k in m, k);
  assert.equal(m.routed, 1);
  const s = (await get('/t/pisak/api/state')).body;
  assert.equal(s.connections, 2);
  assert.equal(s.links.length, 2);
  const page = (await get(`/t/pisak/api/events?since=${ev.seq - 1}&limit=1`)).body;
  assert.equal(page.events[0].seq, ev.seq);
});

test('v0.3: farzad v0.2 envelope rules, sizes and error pass-through', async () => {
  await fresh({ retries: 0 });
  const t1 = await register('n1', [{ appId: 'echo', listenerIds: [] }, { appId: 'sink', listenerIds: ['l-1'] }]);
  await register('n2');
  const bad = async (e, why) => {
    const r = await post('/t/pisak/api/route', e, t1);
    assert.equal(r.status, 400, why);
    assert.equal(r.body.error.code, 'BAD_PROTOCOL', why);
    assert.equal(r.body.error.at, 'gateway', why);
  };
  await bad(env('n1', 'n2', { proto: 'http' }), 'proto');
  await bad(env('n1', 'n2', { version: 1 }), 'version');
  await bad(env('n1', 'n2', { scope: 'planet' }), 'scope');
  await bad({ ...env('n1', '*', { type: 'broadcast' }), destination: { nodeId: '*', appId: 'sink', listenerId: 'l-1' } }, 'listener broadcast');
  const big = await post('/t/pisak/api/route', env('n1', 'n2', { payload: { s: 'x'.repeat(70000) } }), t1);
  assert.equal(big.status, 413);
  assert.equal(big.body.error.code, 'MESSAGE_TOO_LARGE');
  assert.equal((await get('/t/pisak/api/metrics')).body.badRequests, 5);

  const all = await post('/t/pisak/api/route', env('n1', 'n2', { destination: { nodeId: 'n2', appId: '*', listenerId: null } }), t1);
  assert.equal(all.status, 200, 'appId * goes to every app on the node');

  await chaos({ nodeId: 'n2', failWith: { status: 404, code: 'NO_LISTENER' } });
  const nl = await post('/t/pisak/api/route', env('n1', 'n2', { destination: { nodeId: 'n2', appId: 'echo', listenerId: 'zz' } }), t1);
  assert.equal(nl.status, 404);
  assert.equal(nl.body.error.code, 'NO_LISTENER');
  assert.equal(nl.body.error.at, 'n2', 'node errors pass through unchanged');
  await chaos({ nodeId: 'n2', failWith: { status: 503, code: 'PEER_OVERLOADED' } });
  assert.equal((await post('/t/pisak/api/route', env('n1', 'n2'), t1)).body.error.code, 'PEER_OVERLOADED');
  const m = (await get('/t/pisak/api/metrics')).body;
  assert.equal(m.errors.NO_LISTENER, 1);
  assert.equal(m.errors.PEER_OVERLOADED, 1);
  assert.equal(m.windowMs, 10000);
});

test('v0.3: broadcast scope skips external nodes unless scope is all', async () => {
  await fresh();
  const t1 = await register('n1');
  await register('n2');
  await register('x1', ['sink'], { external: true });
  const bcast = scope => post('/t/pisak/api/route', { ...env('n1', '*', { type: 'broadcast', scope }), destination: { nodeId: '*', appId: '*', listenerId: null } }, t1);
  assert.deepEqual((await bcast(undefined)).body.delivered, ['n2']);
  assert.deepEqual((await bcast('cluster')).body.delivered, ['n2']);
  assert.deepEqual((await bcast('all')).body.delivered.sort(), ['n2', 'x1']);
  const s = (await get('/t/pisak/api/state')).body;
  assert.equal(s.nodes.find(x => x.nodeId === 'x1').external, true);
  assert.equal(s.possibleLinks, 3);
  assert.equal(s.openConnections, 3);
  assert.ok(s.links.every(l => l.state === 'reachable' && l.to === 'gateway'));
});

test('v0.3: a restarting or leaving node is not reported down; heartbeat accepts from', async () => {
  await fresh({ probeIntervalMs: 200, probeTimeoutMs: 600 });
  const t1 = await register('n1');
  await register('n2');
  assert.equal((await post('/t/pisak/api/heartbeat', { from: 'n1', seq: 1, ts: Date.now(), state: 'up' }, t1)).status, 200);
  const since = (await get('/t/pisak/api/events?limit=1')).body.seq;
  await chaos({ nodeId: 'n2', state: 'restarting' });
  await waitFor(async () => (await get('/t/pisak/api/state')).body.nodes.find(x => x.nodeId === 'n2').status === 'restarting');
  await chaos({ nodeId: 'n2', killed: true });
  await sleep(1200);
  let s = (await get('/t/pisak/api/state')).body;
  assert.equal(s.nodes.find(x => x.nodeId === 'n2').status, 'restarting');
  assert.equal(s.links.find(l => l.from === 'n2').state, 'restarting');
  await chaos({ nodeId: 'n2', killed: false, state: 'up' });
  await waitFor(async () => (await get('/t/pisak/api/state')).body.nodes.find(x => x.nodeId === 'n2').status === 'up');
  const kinds = (await get(`/t/pisak/api/events?since=${since}`)).body.events.map(e => e.kind);
  assert.ok(kinds.includes('node-restarting'));
  assert.ok(!kinds.includes('node-down'), 'planned restart is not a failure');

  await post('/t/pisak/api/heartbeat', { from: 'n1', state: 'leaving' }, t1);
  s = (await get('/t/pisak/api/state')).body;
  assert.equal(s.nodes.find(x => x.nodeId === 'n1').status, 'leaving');
  assert.equal(s.openConnections, 1);
});

test('v0.3: event paging reports more and truncated', async () => {
  await fresh();
  const t1 = await register('n1');
  await register('n2');
  const first = (await get('/t/pisak/api/events?since=0&limit=1')).body;
  assert.equal(first.truncated, true, 'reset dropped earlier events');
  const start = (await get('/t/pisak/api/events?limit=1')).body.seq;
  for (let i = 0; i < 3; i++) await post('/t/pisak/api/route', env('n1', 'n2', { type: 'oneway' }), t1);
  const p = (await get(`/t/pisak/api/events?since=${start}&limit=2`)).body;
  assert.equal(p.events.length, 2);
  assert.equal(p.more, true);
  assert.equal(p.truncated, false);
  const q = (await get(`/t/pisak/api/events?since=${p.seq}&limit=200`)).body;
  assert.equal(q.more, false);
  assert.equal(q.events[0].seq, p.seq + 1);
});
