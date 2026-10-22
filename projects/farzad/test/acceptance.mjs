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
// the fake gateway counts in /state.routes, the real one in /metrics.routed
const routed = async () => (await get(`${G}/api/state`)).body.routes ?? (await get(`${G}/api/metrics`)).body.routed;
const node = (s, id) => s.nodes.find((n) => n.nodeId === id);
async function lastSeq() {
  let seq = 0;
  for (let more = true; more;) { const e = await get(`${N}/api/events?since=${seq}`); more = e.body.more; seq = e.body.seq; }
  return seq;
}
async function eventsSince(since) {
  const evs = [];
  for (let more = true; more;) { const e = await get(`${N}/api/events?since=${since}`); evs.push(...e.body.events); more = e.body.more; since = e.body.seq; }
  return evs;
}
async function freshMesh(nodes) {
  await post(`${N}/api/reset`, { nodes, mode: 'mesh' });
  await until(async () => (await state()).openConnections === nodes * (nodes - 1), 8000, `mesh of ${nodes} up`);
}
function skip(name, why) { console.log(`SKIP ${name}: ${why}`); }

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

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const TYPES = ['request', 'response', 'oneway', 'broadcast'];
function checkInternals(s) {
  for (const n of s.nodes) {
    ok(n.limits && n.limits.inflight === 50, `${n.nodeId} limits ${JSON.stringify(n.limits)}`);
    ok(isNum(n.queued) && isNum(n.pending), `${n.nodeId} queued/pending ${n.queued} ${n.pending}`);
    ok(n.dedup && isNum(n.dedup.size) && isNum(n.dedup.hits), `${n.nodeId} dedup ${JSON.stringify(n.dedup)}`);
    ok(n.gateway && typeof n.gateway.registered === 'boolean' && (n.gateway.lastProbeAgeMs === null || isNum(n.gateway.lastProbeAgeMs)), `${n.nodeId} gateway ${JSON.stringify(n.gateway)}`);
    const c = n.counters;
    ok(c && TYPES.every((t) => isNum(c.sent[t]) && isNum(c.received[t])) && c.failures && typeof c.failures === 'object', `${n.nodeId} counters ${JSON.stringify(c)}`);
  }
  const sum = s.summary;
  ok(sum && sum.linksByState && sum.clockSync && isNum(sum.clockSync.in) && isNum(sum.clockSync.out), `summary ${JSON.stringify(sum)}`);
  ok(sum.maxAbsOffsetMs === null || isNum(sum.maxAbsOffsetMs), 'summary.maxAbsOffsetMs');
  for (const k of ['messagingDisabled', 'inflight', 'pending', 'queued']) ok(isNum(sum[k]), `summary.${k}`);
  ok(sum.failures && typeof sum.failures === 'object', 'summary.failures');
  const total = Object.values(sum.linksByState).reduce((a, b) => a + b, 0);
  ok(total === s.links.length, `linksByState sums to ${total}, links ${s.links.length}`);
}

await check('state exposes node internals (limits, queue, dedup, counters, link misses, summary)', async () => {
  const s = await state();
  checkInternals(s);
  ok(s.links.every((l) => isNum(l.misses) && (l.heartbeatAgeMs === null || isNum(l.heartbeatAgeMs))), 'mesh links have misses and heartbeatAgeMs');
  ok(s.links.some((l) => isNum(l.heartbeatAgeMs) && l.heartbeatAgeMs < 5000), 'recent heartbeats');
  ok(s.summary.linksByState.reachable === 20 && s.summary.clockSync.in + s.summary.clockSync.out === 20, JSON.stringify(s.summary));
  ok(node(s, 'n2').dedup.hits >= 2, `n2 dedup hits ${node(s, 'n2').dedup.hits} after duplicates`);
  ok(node(s, 'n1').gateway.registered === false && node(s, 'n1').gateway.lastProbeAgeMs === null, 'mesh: not registered');
});

await check('counters move: request n1 to n2, NO_LISTENER counted on the sender', async () => {
  const a = await state();
  const r = await send({ type: 'request', to: { nodeId: 'n2', appId: 'echo' } });
  ok(r.body.outcome === 'response', JSON.stringify(r.body));
  const f = await send({ type: 'request', to: { nodeId: 'n2', appId: 'echo', listenerId: 'no-such' } });
  ok(f.body.error && f.body.error.code === 'NO_LISTENER', JSON.stringify(f.body));
  const u = await send({ type: 'oneway', to: { nodeId: 'n2', appId: 'nope' } });
  ok(u.body.error && u.body.error.code === 'UNKNOWN_APP', JSON.stringify(u.body));
  const b = await state();
  const d = (s, id, k, t) => node(s, id).counters[k][t] || 0;
  ok(d(b, 'n1', 'sent', 'request') - d(a, 'n1', 'sent', 'request') === 2, 'n1 sent.request +2');
  ok(d(b, 'n2', 'received', 'request') - d(a, 'n2', 'received', 'request') === 2, 'n2 received.request +2');
  ok(d(b, 'n2', 'sent', 'response') - d(a, 'n2', 'sent', 'response') === 1, 'n2 sent.response +1');
  ok(d(b, 'n1', 'received', 'response') - d(a, 'n1', 'received', 'response') === 1, 'n1 received.response +1');
  ok(d(b, 'n1', 'sent', 'oneway') - d(a, 'n1', 'sent', 'oneway') === 1, 'n1 sent.oneway +1');
  ok(d(b, 'n1', 'failures', 'NO_LISTENER') - d(a, 'n1', 'failures', 'NO_LISTENER') === 1, 'n1 failures.NO_LISTENER +1');
  ok(d(b, 'n1', 'failures', 'UNKNOWN_APP') - d(a, 'n1', 'failures', 'UNKNOWN_APP') === 1, 'n1 failures.UNKNOWN_APP +1');
  ok(!node(b, 'n2').counters.failures.NO_LISTENER, 'failure not counted on the receiver');
  ok((b.summary.failures.NO_LISTENER || 0) - (a.summary.failures.NO_LISTENER || 0) === 1, 'summary.failures.NO_LISTENER +1');
  ok(b.summary.pending === 0 && node(b, 'n1').pending === 0, 'nothing pending after sync sends');
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

await check('graceful restart: peers see restarting, no failure, back reachable', async () => {
  await freshMesh(4);
  const since = await lastSeq();
  const r = await post(`${N}/api/chaos`, { action: 'restart', nodeId: 'n3', downMs: 4000 });
  ok(r.status === 200 && r.body.status === 'restarting', `restart ${r.status} ${JSON.stringify(r.body)}`);
  const toN3 = (s) => s.links.filter((l) => l.to === 'n3');
  await until(async () => { const s = await state(); return node(s, 'n3').status === 'restarting' && toN3(s).every((l) => l.state === 'restarting'); }, 2000, 'links to n3 restarting');
  await sleep(3200); // longer than 3 missed heartbeats, still inside the grace period
  let s = await state();
  ok(node(s, 'n3').status === 'restarting' && node(s, 'n3').messaging === 'disabled', `n3 during grace: ${node(s, 'n3').status}`);
  ok(toN3(s).every((l) => l.state === 'restarting'), `during grace: ${toN3(s).map((l) => l.state)}`);
  await until(async () => { s = await state(); return node(s, 'n3').status === 'up' && toN3(s).every((l) => l.state === 'reachable'); }, 5000, 'links to n3 reachable again');
  const evs = await eventsSince(since);
  ok(evs.some((e) => e.type === 'node.restarting' && e.to === 'n3'), 'node.restarting event');
  ok(!evs.some((e) => e.type === 'node.down'), 'no node.down');
  ok(!evs.some((e) => e.type === 'link.state' && e.to === 'n3' && e.state === 'unreachable'), 'peers never saw n3 unreachable');
  ok(s.metrics.mesh.detectMs === null, `detectMs ${s.metrics.mesh.detectMs}`);
});

await check('clean leave: DELETE announces leaving, no failure, node removed', async () => {
  const since = await lastSeq();
  const d = await req('DELETE', `${N}/api/nodes/n4`);
  ok(d.status === 200, `delete ${d.status}`);
  let s = await state();
  ok(!node(s, 'n4') && !s.links.some((l) => l.from === 'n4' || l.to === 'n4'), 'n4 and its links removed');
  ok(s.possibleLinks === 6, `possibleLinks ${s.possibleLinks}`);
  await until(async () => { s = await state(); return s.openConnections === 6; }, 3000, 'openConnections 6');
  const evs = await eventsSince(since);
  ok(evs.some((e) => e.type === 'node.leaving' && e.to === 'n4'), 'node.leaving event');
  ok(evs.filter((e) => e.type === 'link.state' && e.to === 'n4' && e.state === 'disabled').length === 3, 'peers disabled their links to n4');
  ok(!evs.some((e) => e.type === 'node.down'), 'no node.down');
  ok(s.metrics.mesh.detectMs === null, `detectMs ${s.metrics.mesh.detectMs}`);
});

await check('clock skew: links to the node go out of sync, clear brings them back', async () => {
  await post(`${N}/api/chaos`, { action: 'skew', nodeId: 'n2', skewMs: 500 });
  const toN2 = (s) => s.links.filter((l) => l.to === 'n2');
  let s;
  await until(async () => { s = await state(); return toN2(s).every((l) => l.clockSync === 'out'); }, 3000, 'out of sync');
  ok(toN2(s).every((l) => l.offsetMs >= 400 && l.offsetMs <= 600), `offsets ${toN2(s).map((l) => l.offsetMs)}`);
  ok(s.links.filter((l) => l.from === 'n2').every((l) => l.clockSync === 'out'), 'links from n2 out too');
  await post(`${N}/api/chaos`, { action: 'clear', nodeId: 'n2' });
  await until(async () => { s = await state(); return s.links.every((l) => l.clockSync === 'in'); }, 3000, 'back in sync');
});

await check('chaos clear resets slow, drop and skew', async () => {
  await post(`${N}/api/chaos`, { action: 'slow', nodeId: 'n3', delayMs: 300 });
  await post(`${N}/api/chaos`, { action: 'drop', nodeId: 'n3', percent: 50 });
  await post(`${N}/api/chaos`, { action: 'skew', nodeId: 'n3', skewMs: 500 });
  let c = node(await state(), 'n3').chaos;
  ok(c.delayMs === 300 && c.dropPercent === 50 && c.skewMs === 500, `set ${JSON.stringify(c)}`);
  const r = await post(`${N}/api/chaos`, { action: 'clear', nodeId: 'n3' });
  ok(r.status === 200, `clear ${r.status}`);
  c = node(await state(), 'n3').chaos;
  ok(c.delayMs === 0 && c.dropPercent === 0 && c.skewMs === 0, `cleared ${JSON.stringify(c)}`);
  for (let i = 0; i < 5; i += 1) {
    const a = await send({ type: 'request', to: { nodeId: 'n3', appId: 'echo' }, ttlMs: 1000 });
    ok(a.body.outcome === 'response' && a.body.latencyMs < 250, `after clear ${JSON.stringify(a.body.error || a.body.latencyMs)}`);
  }
});

await check('PEER_OVERLOADED: more than 50 in flight to a slow node', async () => {
  await post(`${N}/api/chaos`, { action: 'slow', nodeId: 'n2', delayMs: 800 });
  const sink = { nodeId: 'n2', appId: 'sink', listenerId: null };
  const flood = Array.from({ length: 55 }, () => post(`${N}/n/n2/deliver`, env('oneway', { destination: sink, ttlMs: 3000 })));
  await sleep(200);
  const viaSend = await send({ type: 'oneway', to: { nodeId: 'n2', appId: 'sink' } });
  const res = await Promise.all(flood);
  await post(`${N}/api/chaos`, { action: 'clear', nodeId: 'n2' });
  const accepted = res.filter((x) => x.status === 202).length;
  const over = res.filter((x) => x.status === 503 && x.body.error.code === 'PEER_OVERLOADED');
  ok(accepted === 50 && over.length === 5, `accepted ${accepted}, overloaded ${over.length}, statuses ${[...new Set(res.map((x) => x.status))]}`);
  ok(over.every((x) => typeof x.body.correlationId === 'string'), 'correlationId on PEER_OVERLOADED');
  ok(viaSend.body.outcome === 'error' && viaSend.body.error.code === 'PEER_OVERLOADED', `send ${JSON.stringify(viaSend.body)}`);
});

await check('messaging disabled: send is queued until enabled, else TIMEOUT', async () => {
  await freshMesh(3);
  const since = await lastSeq();
  const a = await post(`${N}/api/nodes`, { count: 1 });
  ok(a.status === 201 && a.body.nodes[0] === 'n4', `add ${a.status} ${JSON.stringify(a.body)}`);
  ok(node(await state(), 'n4').messaging === 'disabled', 'new node starts disabled');
  const q = await post(`${N}/api/send`, { from: { nodeId: 'n4', appId: 'echo' }, type: 'request', to: { nodeId: 'n1', appId: 'echo' }, ttlMs: 5000, async: true });
  ok(q.status === 202, `async ${q.status}`);
  let r;
  await until(async () => { r = (await get(`${N}/api/requests/${q.body.requestId}`)).body; return r.outcome !== 'pending'; }, 5000, 'queued send done');
  ok(r.outcome === 'response', `queued send ${JSON.stringify(r)}`);
  const evs = await eventsSince(since);
  const en = evs.find((e) => e.type === 'messaging.enabled' && e.to === 'n4');
  const msg = evs.find((e) => e.type === 'message.request' && e.requestId === q.body.requestId);
  ok(en && msg && en.seq < msg.seq, 'went out after messaging.enabled');
  for (const id of ['n1', 'n2', 'n3', 'n4']) await post(`${N}/api/chaos`, { action: 'kill', nodeId: id });
  await post(`${N}/api/nodes`, { count: 1 });
  const t = await post(`${N}/api/send`, { from: { nodeId: 'n5', appId: 'echo' }, type: 'request', to: { nodeId: 'n1', appId: 'echo' }, ttlMs: 800 });
  ok(t.status === 200 && t.body.outcome === 'timeout' && t.body.error.code === 'TIMEOUT', `never enabled ${JSON.stringify(t.body)}`);
  ok(t.body.latencyMs >= 750, `waited ttlMs ${t.body.latencyMs}`);
  ok(node(await state(), 'n5').messaging === 'disabled', 'n5 still disabled');
});

await check('MAX_NODES: more than 20 nodes gives 409', async () => {
  await post(`${N}/api/reset`, { nodes: 3, mode: 'mesh' });
  const a = await post(`${N}/api/nodes`, { count: 18 });
  ok(a.status === 409 && a.body.error.code === 'MAX_NODES', `21 nodes: ${a.status} ${JSON.stringify(a.body)}`);
  ok((await state()).nodes.length === 3, 'nothing added');
  const b = await post(`${N}/api/nodes`, { count: 17 });
  ok(b.status === 201 && b.body.nodes.length === 17, `20 nodes: ${b.status}`);
  const c = await post(`${N}/api/nodes`, { count: 1, external: true });
  ok(c.status === 409 && c.body.error.code === 'MAX_NODES', `external counts: ${c.status}`);
});

await check('external node: only via the gateway; scope cluster excludes it, scope all includes it', async () => {
  await freshMesh(5);
  const a = await post(`${N}/api/nodes`, { count: 1, external: true });
  ok(a.status === 201 && a.body.nodes[0] === 'n6', `add external ${a.status}`);
  let s;
  await until(async () => { s = await state(); return s.links.some((l) => l.from === 'n6' && l.to === 'gateway' && l.state === 'reachable'); }, 5000, 'n6 registered');
  ok(node(s, 'n6').external === true, 'external flag');
  ok(!s.links.some((l) => (l.from === 'n6' || l.to === 'n6') && l.to !== 'gateway'), 'no mesh links for n6');
  ok(s.possibleLinks === 21, `possibleLinks ${s.possibleLinks}`);
  const before = await routed();
  const r = await send({ type: 'request', to: { nodeId: 'n6', appId: 'echo' } });
  ok(r.body.outcome === 'response' && r.body.response.source.nodeId === 'n6', `request ${JSON.stringify(r.body)}`);
  ok(await routed() > before, 'went through the gateway');
  const c = await send({ type: 'broadcast', to: { nodeId: '*', appId: 'sink' }, scope: 'cluster' });
  ok(c.body.outcome === 'broadcast' && c.body.delivered.length === 4 && !c.body.delivered.includes('n6'), `cluster ${JSON.stringify(c.body)}`);
  const all = await send({ type: 'broadcast', to: { nodeId: '*', appId: 'sink' }, scope: 'all' });
  ok(all.body.delivered.length === 5 && all.body.delivered.includes('n6') && !all.body.failed.length, `all ${JSON.stringify(all.body)}`);
});

await check('MIN_NODES on delete', async () => {
  await post(`${N}/api/reset`, { nodes: 3, mode: 'mesh' });
  const s = await state();
  ok(s.nodes.every((n) => TYPES.every((t) => n.counters.sent[t] === 0 && n.counters.received[t] === 0) && !Object.keys(n.counters.failures).length && n.dedup.hits === 0), 'reset clears counters');
  ok(!Object.keys(s.summary.failures).length, 'reset clears summary.failures');
  const r = await req('DELETE', `${N}/api/nodes/n1`);
  ok(r.status === 409 && r.body.error.code === 'MIN_NODES', `${r.status}`);
});

await check('switch to gateway mode and route through it', async () => {
  await post(`${N}/api/reset`, { nodes: 5, mode: 'mesh' });
  await until(async () => (await state()).openConnections === 20, 8000, 'mesh up');
  const r = await post(`${N}/api/mode`, { mode: 'gateway' });
  ok(r.status === 200 && r.body.mode === 'gateway', `mode ${r.status} ${JSON.stringify(r.body)}`);
  await until(async () => { const s = await state(); return s.mode === 'gateway' && s.possibleLinks === 5 && s.links.every((l) => l.to === 'gateway'); }, 5000, 'gateway links');
  // the switch resets the gateway's counter
  const before = await routed();
  const a = await send({ type: 'request', to: { nodeId: 'n3', appId: 'echo' } });
  ok(a.body.outcome === 'response', `route ${JSON.stringify(a.body)}`);
  const b = await send({ type: 'broadcast', to: { nodeId: '*', appId: 'sink' } });
  ok(b.body.delivered && b.body.delivered.length === 4, `broadcast ${JSON.stringify(b.body)}`);
  const after = await routed();
  ok(after - before >= 2, 'went through gateway');
  const s = await state();
  checkInternals(s);
  ok(s.links.every((l) => l.misses === null), 'gateway links have misses null');
  const n1 = node(s, 'n1');
  ok(n1.gateway.registered === true && isNum(n1.gateway.lastProbeAgeMs), `n1 gateway ${JSON.stringify(n1.gateway)}`);
  ok(n1.counters.sent.request >= 1 && n1.counters.sent.broadcast >= 1, `n1 counters ${JSON.stringify(n1.counters.sent)}`);
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

{
  const name = 'REJECTED rate_limit from the gateway reaches the sender';
  const cfg = await post(`${G}/api/admin`, { action: 'config', config: { rateLimitPerSec: 1, rateLimitBurst: 1 } });
  if (!(cfg.status === 200 && cfg.body && cfg.body.ok === true)) skip(name, 'this gateway has no rate limit config');
  else {
    await check(name, async () => {
      try {
        const rs = [];
        for (let i = 0; i < 3; i += 1) rs.push(await send({ type: 'request', from: { nodeId: 'n2', appId: 'echo' }, to: { nodeId: 'n3', appId: 'echo' } }));
        const rej = rs.find((x) => x.body.error && x.body.error.code === 'REJECTED');
        ok(rej, `no REJECTED: ${rs.map((x) => x.body.outcome)}`);
        ok(rej.body.outcome === 'failure' && rej.body.error.reason === 'rate_limit' && rej.body.error.at === 'gateway', JSON.stringify(rej.body));
      } finally {
        await post(`${G}/api/admin`, { action: 'config', config: { rateLimitPerSec: 50, rateLimitBurst: 100 } });
      }
    });
  }
}

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
