// Integration test for the pisak gateway plugin against fake nodes, on a real board server.
// Run from the repo root: node projects/pisak/test/gateway.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

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
  await admin({ action: 'ha', enabled: false });
  await admin({ action: 'revive' });
  await admin({ action: 'reset' });
  for (const id of ['n1', 'n2', 'n3', 'x1']) await chaos({ nodeId: id, killed: false, delayMs: 0, fail503: false, failWith: null, state: 'up', redirect: null });
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

test('v0.4: redirects are never followed, not on delivery and not on probes', async () => {
  await fresh({ retries: 2, probeIntervalMs: 100, probeTimeoutMs: 400 });
  const t1 = await register('n1');
  await register('n2');
  await register('n3');
  const count = async () => ((await get('/t/fakenodes/received')).body.n3 || []).length;
  const before = await count();
  await chaos({ nodeId: 'n2', redirect: 'n3' });
  const r = await post('/t/pisak/api/route', env('n1', 'n2'), t1);
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, 'NODE_UNAVAILABLE');
  assert.equal(r.body.error.reason, 'bad_response');
  assert.equal(await count(), before, 'the redirect target got nothing');
  // n3 answers its heartbeat, so n2 only goes down if the probe refuses to follow the 307 to n3.
  await waitFor(async () => (await get('/t/pisak/api/state')).body.nodes.find(x => x.nodeId === 'n2').status === 'down');
  assert.equal((await get('/t/pisak/api/state')).body.nodes.find(x => x.nodeId === 'n3').status, 'up');
});

test('v0.4: a tiny ttlMs is raised to 50 ms and sender-budget timeouts do not open the breaker', async () => {
  await fresh({ retries: 0, breakerFailures: 2, defaultTtlMs: 300, rateLimitPerSec: 1000, rateLimitBurst: 1000 });
  const t1 = await register('n1');
  await register('n2');
  const ok = await post('/t/pisak/api/route', env('n1', 'n2', { ttlMs: 0.5 }), t1);
  assert.equal(ok.status, 200, 'a 0.5 ms ttl is raised to the 50 ms minimum');

  await chaos({ nodeId: 'n2', delayMs: 120 });
  for (let i = 0; i < 4; i++) {
    const r = await post('/t/pisak/api/route', env('n1', 'n2', { ttlMs: 60 }), t1);
    assert.equal(r.body.error.code, 'TIMEOUT', JSON.stringify(r.body));
  }
  const circuit = async () => (await get('/t/pisak/api/state')).body.nodes.find(x => x.nodeId === 'n2').circuit;
  assert.equal(await circuit(), 'closed', 'short sender budgets are not the receiver\'s fault');
  await chaos({ nodeId: 'n2', delayMs: 0 });
  assert.equal((await post('/t/pisak/api/route', env('n1', 'n2'), t1)).status, 200);

  await chaos({ nodeId: 'n2', delayMs: 500 });
  for (let i = 0; i < 2; i++) assert.equal((await post('/t/pisak/api/route', env('n1', 'n2'), t1)).body.error.code, 'TIMEOUT');
  assert.equal(await circuit(), 'open', 'timeouts within the gateway default ttl still count');
});

test('v0.5: probes carry the gateway membership as peers', async () => {
  await fresh({ probeIntervalMs: 100, probeTimeoutMs: 400 });
  await register('n1');
  await register('n2');
  await register('n3');
  await chaos({ nodeId: 'n3', killed: true });
  await waitFor(async () => (await get('/t/pisak/api/state')).body.nodes.find(x => x.nodeId === 'n3').status === 'down');
  const peers = await waitFor(async () => {
    const p = (await get('/t/fakenodes/probes')).body.n1;
    return p && p.peers && p.peers.n3 === 'down' && p.peers;
  });
  assert.deepEqual(peers, { n2: 'up', n3: 'down' }, 'every other node with its status, never the node itself');
  const probe = (await get('/t/fakenodes/probes')).body.n1;
  assert.equal(probe.from, 'gateway');
  assert.equal(probe.state, 'up');
});

const gwState = async () => (await get('/t/pisak/api/state')).body;

test('v0.6: HA is off by default and a killed gateway stays down', async () => {
  await fresh();
  const t1 = await register('n1');
  await register('n2');
  let s = await gwState();
  assert.equal(s.ha.enabled, false);
  assert.deepEqual(s.ha.instances.map(i => i.role).sort(), ['active', 'off']);
  await admin({ action: 'kill' });
  await sleep(1300);
  s = await gwState();
  assert.equal(s.gateway.status, 'down', 'no failover without HA');
  assert.equal((await post('/t/pisak/api/route', env('n1', 'n2'), t1)).body.error.reason, 'gateway_down');
  assert.equal((await admin({ action: 'kill', instance: s.ha.active === 'a' ? 'b' : 'a' })).status, 400, 'standby is not running');
  assert.equal((await admin({ action: 'kill', instance: 'z' })).status, 400);
  assert.equal((await admin({ action: 'ha' })).status, 400);
  assert.equal((await admin({ action: 'ha', enabled: true, detectMs: 5 })).status, 400);
});

test('v0.6: HA pair fails over without re-registration and fails back', async () => {
  await fresh({ probeIntervalMs: 200, probeTimeoutMs: 1000 });
  const ha = await admin({ action: 'ha', enabled: true, detectMs: 300 });
  assert.equal(ha.status, 200);
  const first = ha.body.state.ha.active;
  const second = first === 'a' ? 'b' : 'a';
  assert.deepEqual(ha.body.state.ha.instances.map(i => i.status), ['up', 'up']);
  const t1 = await register('n1');
  await register('n2');
  await sleep(400); // one replication tick
  assert.equal((await gwState()).ha.instances.find(i => i.id === second).nodes, 2, 'registry replicated to the standby');
  assert.equal((await post('/t/pisak/api/route', env('n1', 'n2'), t1)).status, 200);
  const since = (await get('/t/pisak/api/events?limit=1')).body.seq;

  await admin({ action: 'kill' });
  assert.equal((await post('/t/pisak/api/route', env('n1', 'n2'), t1)).body.error.reason, 'gateway_down', 'down during detection');
  const s = await waitFor(async () => { const v = await gwState(); return v.ha.active === second && v; }, 3000);
  assert.equal(s.gateway.status, 'up');
  assert.equal(s.ha.failovers >= 1, true);
  assert.ok(s.ha.lastFailoverMs >= 300 && s.ha.lastFailoverMs < 1000, `failoverMs ${s.ha.lastFailoverMs}`);
  assert.equal((await post('/t/pisak/api/route', env('n1', 'n2'), t1)).status, 200, 'same token works on the new active');
  const ev = (await get(`/t/pisak/api/events?since=${since}`)).body.events.find(e => e.kind === 'gateway-failover');
  assert.equal(ev.from, first);
  assert.equal(ev.to, second);
  assert.equal(ev.nodes, 2);
  await sleep(1300); // longer than probeTimeoutMs: the new active's own probes keep the nodes up
  assert.ok((await gwState()).nodes.every(n => n.status === 'up'));

  await admin({ action: 'revive' });
  await sleep(400);
  const back = await gwState();
  assert.deepEqual(back.ha.instances.map(i => [i.id, i.status, i.nodes]), [['a', 'up', 2], ['b', 'up', 2]]);
  assert.equal(back.ha.instances.find(i => i.id === first).role, 'standby');
  await admin({ action: 'kill', instance: second });
  await waitFor(async () => (await gwState()).ha.active === first, 3000);
  assert.equal((await post('/t/pisak/api/route', env('n1', 'n2'), t1)).status, 200, 'fail back keeps tokens too');
  await admin({ action: 'revive' });
});

test('v0.6: enabling HA while the gateway is dead starts the standby as active', async () => {
  await fresh();
  const dead = (await admin({ action: 'kill' })).body.state.ha;
  const r = await admin({ action: 'ha', enabled: true });
  assert.equal(r.body.state.gateway.status, 'up');
  assert.notEqual(r.body.state.ha.active, dead.active, 'the standby took over at once');
  assert.equal(r.body.state.ha.failovers, dead.failovers, 'not counted as a failover');
  await register('n1');
  await admin({ action: 'ha', enabled: false });
  const s = await gwState();
  assert.equal(s.gateway.status, 'up', 'disabling HA keeps the running instance');
  assert.equal(s.ha.instances.filter(i => i.role === 'off').length, 1);
  await admin({ action: 'revive' });
});

test('v0.6: a registration right before the failover survives it (write-through)', async () => {
  await fresh({ probeIntervalMs: 200, probeTimeoutMs: 1000 });
  const first = (await admin({ action: 'ha', enabled: true, detectMs: 200 })).body.state.ha.active;
  await register('n2');
  const t1 = await register('n1');
  await admin({ action: 'kill' });
  await waitFor(async () => (await gwState()).ha.active !== first, 3000);
  assert.equal((await post('/t/pisak/api/route', env('n1', 'n2'), t1)).status, 200, 'token from just before the kill still works');
  await admin({ action: 'revive' });
});

test('v0.6: with HA off the pair is byte-identical to a single v0.5 gateway (spore backend-10)', () => {
  const require = createRequire(import.meta.url);
  const { Gateway } = require(path.join(root, 'board/plugins/pisak/gateway.js'));
  const { GatewayPair } = require(path.join(root, 'board/plugins/pisak/ha.js'));
  const clocks = new Set(['startedAt', 'lastSeen', 'ts', 'registeredAt', 'graceUntil']);
  const norm = v => JSON.stringify(v, (k, x) => (clocks.has(k) ? 0 : k === 'token' ? 'tok' : x));
  const single = new Gateway('a'), pair = new GatewayPair();
  const steps = [
    g => g.register({ nodeId: 'n1', apps: ['echo'], deliverUrl: '/t/fakenodes/n/n1/deliver' }),
    g => g.register({ nodeId: 'n2', apps: ['echo', { appId: 'sink' }], deliverUrl: '/t/fakenodes/n/n2/deliver', external: true }),
    g => g.register({ nodeId: 'bad' }),
    g => g.admin({ action: 'config', config: { retries: 1 } }),
    g => g.admin({ action: 'kill' }),
    g => g.admin({ action: 'reset' }),
    g => g.admin({ action: 'revive' }),
  ];
  for (const step of steps) {
    const a = step(single), b = step(pair);
    const stripHa = r => (r && r.body && r.body.state ? { ...r, body: { ...r.body, state: { ...r.body.state, ha: undefined } } } : r);
    assert.equal(norm(stripHa(b)), norm(a), 'answer differs at ' + step);
    const { ha, ...rest } = pair.state();
    assert.equal(norm(rest), norm(single.state()), 'state differs after ' + step);
  }
});
