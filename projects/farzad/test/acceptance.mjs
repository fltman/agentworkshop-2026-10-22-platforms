// Acceptance tests for the Node module against CONTRACT.md. Also the FLUX fitness function.
//   node acceptance.mjs <baseUrl>        e.g. http://127.0.0.1:8191
// Needs the board running with our plugin at /t/farzad/ and a gateway (real or test/fake-gateway) at /t/pisak/.
// Prints one line per check and a final "SCORE passed/total".
const BASE = (process.argv[2] || 'http://127.0.0.1:8180').replace(/\/$/, '');
const N = `${BASE}/t/farzad`;
const G = `${BASE}/t/pisak`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0; let total = 0;

async function req(method, url, body) {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch { /* empty */ }
  return { status: r.status, body: j };
}
const post = (p, b) => req('POST', p, b);
const get = (p) => req('GET', p);
const state = async () => (await get(`${N}/api/state`)).body;

async function check(name, fn) {
  total += 1;
  try { await fn(); passed += 1; console.log(`PASS ${name}`); } catch (e) { console.log(`FAIL ${name}: ${e && e.message}`); }
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }
async function until(fn, ms, msg) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return; } catch { /* retry */ } await sleep(200); }
  throw new Error(`timed out: ${msg}`);
}
const env = (type, extra = {}) => ({ proto: 'nodelink', version: 2, messageId: `t-${Math.random().toString(36).slice(2)}`, type,
  source: { nodeId: 'n1', appId: 'echo', listenerId: null }, destination: { nodeId: 'n2', appId: 'echo', listenerId: null },
  timestamp: Date.now(), ttlMs: 1500, payload: { hi: 1 }, ...extra });
const send = (b) => post(`${N}/api/send`, { from: { nodeId: 'n1', appId: 'echo' }, ttlMs: 1500, payload: { x: 1 }, ...b });

await post(`${G}/api/admin`, { action: 'reset' });

await check('reset 5 nodes in mesh', async () => {
  const r = await post(`${N}/api/reset`, { nodes: 5, mode: 'mesh' });
  ok(r.status === 200, `status ${r.status}`);
  await until(async () => { const s = await state(); return s.nodes.length === 5 && s.openConnections === 20; }, 8000, 'openConnections 20');
  const s = await state();
  ok(s.mode === 'mesh' && s.possibleLinks === 20, `mode ${s.mode} possibleLinks ${s.possibleLinks}`);
  ok(s.heartbeat && s.heartbeat.intervalMs === 1000 && s.heartbeat.missesBeforeDown === 3, 'heartbeat settings');
  ok(s.maxMessageBytes === 65536, 'maxMessageBytes');
  ok(s.nodes.every((n) => n.messaging === 'enabled' && n.status === 'up'), 'all nodes up and enabled');
  ok(s.links.length === 20 && s.links.every((l) => l.state === 'reachable' && ['in', 'out'].includes(l.clockSync)), 'links reachable with clockSync');
});

await check('request/response echo', async () => {
  const r = await send({ type: 'request', to: { nodeId: 'n3', appId: 'echo' }, userData: { u: 7 } });
  ok(r.status === 200, `status ${r.status}`);
  const b = r.body;
  ok(b.outcome === 'response', `outcome ${b.outcome}`);
  ok(b.userData && b.userData.u === 7, 'userData returned');
  ok(typeof b.latencyMs === 'number', 'latencyMs');
  const resp = b.response;
  ok(resp && resp.type === 'response' && resp.proto === 'nodelink' && resp.version === 2, 'response envelope');
  ok(resp.source.nodeId === 'n3' && resp.destination.nodeId === 'n1', 'source/destination swapped');
  ok(resp.correlationId === b.messageId, 'correlationId = request messageId');
  ok(/^n1-\d+$/.test(b.messageId), `messageId format ${b.messageId}`);
  ok(JSON.stringify(resp.payload) === JSON.stringify({ x: 1 }), 'payload echoed');
});

await check('oneway to sink is accepted', async () => {
  const r = await send({ type: 'oneway', to: { nodeId: 'n2', appId: 'sink' } });
  ok(r.status === 200 && r.body.outcome === 'accepted', `${r.status} ${r.body && r.body.outcome}`);
});

await check('error codes UNKNOWN_NODE / UNKNOWN_APP / NO_LISTENER', async () => {
  const a = await send({ type: 'request', to: { nodeId: 'n99', appId: 'echo' } });
  ok(a.body.outcome === 'failure' && a.body.error.code === 'UNKNOWN_NODE', `n99: ${JSON.stringify(a.body)}`);
  const b = await send({ type: 'request', to: { nodeId: 'n2', appId: 'nope' } });
  ok(b.body.error && b.body.error.code === 'UNKNOWN_APP', `nope: ${JSON.stringify(b.body)}`);
  const c = await send({ type: 'request', to: { nodeId: 'n2', appId: 'echo', listenerId: 'no-such' } });
  ok(c.body.error && c.body.error.code === 'NO_LISTENER', `listener: ${JSON.stringify(c.body)}`);
  const d = await send({ type: 'oneway', to: { nodeId: 'n2', appId: 'nope' } });
  ok(d.body.outcome === 'error' && d.body.error.code === 'UNKNOWN_APP', `oneway error: ${JSON.stringify(d.body)}`);
});

await check('broadcast reaches all peers except sender', async () => {
  const r = await send({ type: 'broadcast', to: { nodeId: '*', appId: 'sink' }, scope: 'cluster' });
  ok(r.body.outcome === 'broadcast', `outcome ${r.body.outcome}`);
  ok(r.body.delivered.length === 4 && !r.body.delivered.includes('n1'), `delivered ${r.body.delivered}`);
  const bad = await send({ type: 'request', to: { nodeId: '*', appId: 'echo' } });
  ok(bad.body.error && bad.body.error.code === 'BAD_PROTOCOL', 'nodeId * needs broadcast');
});

await check('all apps on one node (appId *)', async () => {
  const r = await send({ type: 'oneway', to: { nodeId: 'n2', appId: '*' } });
  ok(r.status === 200 && r.body.outcome === 'accepted', JSON.stringify(r.body));
  const bad = await send({ type: 'broadcast', to: { nodeId: 'n2', appId: '*' } });
  ok(bad.body.error && bad.body.error.code === 'BAD_PROTOCOL', 'broadcast needs nodeId *');
});

await check('listener instance addressing + msgTypes', async () => {
  const r = await post(`${N}/api/nodes/n4/apps`, { appId: 'billing', listenerId: 'L-1', msgTypes: { 1: 'QUERY' } });
  ok(r.status === 200 || r.status === 201, `register app ${r.status}`);
  const s = await state();
  const app = s.nodes.find((n) => n.nodeId === 'n4').apps.find((a) => a.appId === 'billing');
  ok(app && app.listenerIds.includes('L-1') && app.msgTypes['1'] === 'QUERY', 'app in state');
  const o = await send({ type: 'oneway', to: { nodeId: 'n4', appId: 'billing', listenerId: 'L-1' }, msgTypeId: 1 });
  ok(o.body.outcome === 'accepted', `oneway to listener ${JSON.stringify(o.body)}`);
});

await check('MESSAGE_TOO_LARGE', async () => {
  const r = await send({ type: 'request', to: { nodeId: 'n2', appId: 'echo' }, payload: { big: 'x'.repeat(70000) } });
  ok(JSON.stringify(r.body).includes('MESSAGE_TOO_LARGE'), JSON.stringify(r.body).slice(0, 200));
  const d = await post(`${N}/n/n2/deliver`, env('oneway', { payload: { big: 'x'.repeat(70000) } }));
  ok(d.status === 413 && d.body.error.code === 'MESSAGE_TOO_LARGE', `deliver ${d.status}`);
});

await check('BAD_PROTOCOL on deliver', async () => {
  const d = await post(`${N}/n/n2/deliver`, env('request', { proto: 'other' }));
  ok(d.status === 400 && d.body.error.code === 'BAD_PROTOCOL', `${d.status}`);
  const v = await post(`${N}/n/n2/deliver`, env('request', { version: 99 }));
  ok(v.status === 400 && v.body.error.code === 'BAD_PROTOCOL', `version ${v.status}`);
});

await check('deliver request directly + duplicate suppression', async () => {
  const e = env('request');
  const a = await post(`${N}/n/n2/deliver`, e);
  ok(a.status === 200 && a.body.type === 'response', `first ${a.status}`);
  const b = await post(`${N}/n/n2/deliver`, e);
  ok(b.status === 200 && JSON.stringify(b.body) === JSON.stringify(a.body), 'duplicate gets same response');
  const o = env('oneway', { destination: { nodeId: 'n2', appId: 'sink', listenerId: null } });
  const c1 = await post(`${N}/n/n2/deliver`, o);
  const c2 = await post(`${N}/n/n2/deliver`, o);
  ok(c1.status === 202 && c2.status === 202 && c2.body.duplicate === true, 'duplicate oneway');
});

await check('heartbeat answers probes', async () => {
  const r = await post(`${N}/n/n2/heartbeat`, { from: 'gateway', ts: Date.now() });
  ok(r.status === 200 && r.body.nodeId === 'n2' && typeof r.body.receivedTs === 'number', JSON.stringify(r.body));
});

await check('async request + result + abort', async () => {
  const a = await send({ type: 'request', to: { nodeId: 'n2', appId: 'echo' }, async: true });
  ok(a.status === 202 && a.body.requestId, `async ${a.status}`);
  await until(async () => (await get(`${N}/api/requests/${a.body.requestId}`)).body.outcome === 'response', 3000, 'async result');
  await post(`${N}/api/chaos`, { action: 'slow', nodeId: 'n5', delayMs: 1000 });
  const b = await send({ type: 'request', to: { nodeId: 'n5', appId: 'echo' }, async: true, ttlMs: 3000 });
  const d = await req('DELETE', `${N}/api/requests/${b.body.requestId}`);
  ok(d.status === 200 || d.status === 204, `abort ${d.status}`);
  await post(`${N}/api/chaos`, { action: 'clear', nodeId: 'n5' });
});

await check('events: shared shape and paging', async () => {
  const r = await get(`${N}/api/events?since=0`);
  ok(r.status === 200 && Array.isArray(r.body.events) && r.body.events.length > 0, 'events');
  const e = r.body.events[0];
  for (const k of ['id', 'seq', 'ts', 'type', 'from', 'to', 'ok', 'latencyMs', 'errorCode']) ok(k in e, `field ${k}`);
  ok(r.body.seq === r.body.events[r.body.events.length - 1].seq, 'seq = last returned');
  ok(typeof r.body.more === 'boolean' && typeof r.body.truncated === 'boolean', 'more/truncated');
  ok(r.body.events.length <= 200, 'max 200');
  const n = await get(`${N}/api/events?since=${r.body.seq}`);
  ok(n.body.events.every((x) => x.seq > r.body.seq), 'since exclusive');
});

await check('traffic generator produces metrics', async () => {
  await post(`${N}/api/traffic`, { rate: 20, mix: { request: 0.6, oneway: 0.3, broadcast: 0.1 }, payloadBytes: 128 });
  await sleep(3000);
  const s = await state();
  await post(`${N}/api/traffic`, { rate: 0 });
  const m = s.metrics.mesh;
  ok(m.throughputPerSec > 5 && m.p50Ms !== null && m.p95Ms >= m.p50Ms, JSON.stringify(m));
});

await check('scale to 15 nodes', async () => {
  const r = await post(`${N}/api/nodes`, { count: 10 });
  ok(r.status === 200 || r.status === 201, `add ${r.status}`);
  await until(async () => { const s = await state(); return s.nodes.length === 15 && s.openConnections === 210; }, 10000, 'openConnections 210');
  const over = await post(`${N}/api/nodes`, { count: 10 });
  ok(over.status >= 400, 'max 20 enforced');
});

await check('kill a node: detection in mesh', async () => {
  let before = 0;
  for (let more = true; more;) { const e = await get(`${N}/api/events?since=${before}`); more = e.body.more; before = e.body.seq; }
  const evs = [];
  await post(`${N}/api/chaos`, { action: 'kill', nodeId: 'n3' });
  await until(async () => { const s = await state(); return s.metrics.mesh.detectMs !== null && s.nodes.find((n) => n.nodeId === 'n3').status === 'down'; }, 8000, 'node.down');
  const s = await state();
  ok(s.metrics.mesh.detectMs >= 2000 && s.metrics.mesh.detectMs <= 6000, `detectMs ${s.metrics.mesh.detectMs}`);
  ok(s.openConnections < s.possibleLinks, 'openConnections dropped');
  const r = await send({ type: 'request', to: { nodeId: 'n3', appId: 'echo' }, ttlMs: 800 });
  ok(['NODE_UNAVAILABLE', 'TIMEOUT'].includes(r.body.error && r.body.error.code), JSON.stringify(r.body));
  for (let since = before, more = true; more;) {
    const ev = await get(`${N}/api/events?since=${since}`);
    evs.push(...ev.body.events); more = ev.body.more; since = ev.body.seq;
  }
  ok(evs.some((e) => e.type === 'node.down' && e.to === 'n3'), 'node.down event');
});

await check('chaos slow and drop', async () => {
  await post(`${N}/api/chaos`, { action: 'slow', nodeId: 'n2', delayMs: 400 });
  const a = await send({ type: 'request', to: { nodeId: 'n2', appId: 'echo' } });
  ok(a.body.latencyMs >= 380, `slow latency ${a.body.latencyMs}`);
  await post(`${N}/api/chaos`, { action: 'drop', nodeId: 'n2', percent: 100 });
  const b = await send({ type: 'request', to: { nodeId: 'n2', appId: 'echo' }, ttlMs: 700 });
  ok(b.body.error && b.body.error.code === 'TIMEOUT', `drop ${JSON.stringify(b.body)}`);
  await post(`${N}/api/chaos`, { action: 'clear', nodeId: 'n2' });
});

await check('MIN_NODES on delete', async () => {
  await post(`${N}/api/reset`, { nodes: 3, mode: 'mesh' });
  const r = await req('DELETE', `${N}/api/nodes/n1`);
  ok(r.status === 409 && r.body.error.code === 'MIN_NODES', `${r.status}`);
});

await check('switch to gateway mode and route through it', async () => {
  await post(`${N}/api/reset`, { nodes: 5, mode: 'mesh' });
  await until(async () => (await state()).openConnections === 20, 8000, 'mesh up');
  const r = await post(`${N}/api/mode`, { mode: 'gateway' });
  ok(r.status === 200 && r.body.mode === 'gateway', `mode ${r.status} ${JSON.stringify(r.body)}`);
  await until(async () => { const s = await state(); return s.mode === 'gateway' && s.possibleLinks === 5 && s.links.every((l) => l.to === 'gateway'); }, 5000, 'gateway links');
  // the fake gateway counts in /state.routes, the real one in /metrics.routed; the switch resets the counter
  const routed = async () => (await get(`${G}/api/state`)).body.routes ?? (await get(`${G}/api/metrics`)).body.routed;
  const before = await routed();
  const a = await send({ type: 'request', to: { nodeId: 'n3', appId: 'echo' } });
  ok(a.body.outcome === 'response', `route ${JSON.stringify(a.body)}`);
  const b = await send({ type: 'broadcast', to: { nodeId: '*', appId: 'sink' } });
  ok(b.body.delivered && b.body.delivered.length === 4, `broadcast ${JSON.stringify(b.body)}`);
  const after = await routed();
  ok(after - before >= 2, 'went through gateway');
});

await check('gateway mode: kill node, detection via gateway', async () => {
  await post(`${N}/api/chaos`, { action: 'kill', nodeId: 'n4' });
  await until(async () => (await state()).metrics.gateway.detectMs !== null, 9000, 'gateway detectMs');
  const s = await state();
  ok(s.metrics.gateway.detectMs >= 1000 && s.metrics.gateway.detectMs <= 7000, `detectMs ${s.metrics.gateway.detectMs}`);
});

await check('gateway down: NODE_UNAVAILABLE at gateway', async () => {
  await post(`${G}/api/admin`, { action: 'kill' });
  const r = await send({ type: 'request', to: { nodeId: 'n2', appId: 'echo' } });
  ok(r.body.error && r.body.error.code === 'NODE_UNAVAILABLE' && r.body.error.at === 'gateway', JSON.stringify(r.body));
  await post(`${G}/api/admin`, { action: 'revive' });
});

await check('gateway revive drops registrations: node re-registers on 401 and the send succeeds', async () => {
  let last;
  await until(async () => { last = await send({ type: 'request', to: { nodeId: 'n2', appId: 'echo' } }); return last.body.outcome === 'response'; }, 8000, 'send after revive');
  ok(last.body.outcome === 'response', JSON.stringify(last.body));
});

await check('back to mesh, then failed switch rolls back', async () => {
  const m = await post(`${N}/api/mode`, { mode: 'mesh' });
  ok(m.status === 200, `to mesh ${m.status}`);
  await until(async () => { const s = await state(); return s.mode === 'mesh' && s.links.some((l) => l.state === 'reachable'); }, 8000, 'mesh rebuilt');
  await post(`${G}/api/admin`, { action: 'kill' });
  const r = await post(`${N}/api/mode`, { mode: 'gateway' });
  ok(r.status === 502 && r.body.error.code === 'MODE_SWITCH_FAILED', `${r.status} ${JSON.stringify(r.body)}`);
  ok((await state()).mode === 'mesh', 'stayed in mesh');
  await post(`${G}/api/admin`, { action: 'revive' });
});

console.log(`SCORE ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
