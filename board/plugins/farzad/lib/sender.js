'use strict';
// Sending: POST /api/send, async requests with abort, mesh/gateway dispatch and the traffic generator.
const E = require('./envelope');
const gw = require('./gateway-client');
const { call } = require('./http');

const MAX_TTL = 60000;
const MAX_RECORDS = 1000;
const TRAFFIC_MAX_INFLIGHT = 200;
const USABLE = new Set(['reachable', 'initializing']);
const log = (...a) => console.error('[farzad]', ...a);

function bad(message) { return { status: 400, body: { error: E.error('BAD_PROTOCOL', 'node', message), correlationId: null } }; }
function stripErr(e) { const { unreachable, ...rest } = e; return rest; }

class Sender {
  constructor(cluster) {
    this.c = cluster;
    this.records = new Map();
    this.reqSeq = 0;
    this.traffic = null;
    this.trafficInflight = 0;
    this.acc = 0;
  }

  teardown() {
    for (const r of this.records.values()) if (r.state === 'pending') { r.state = 'aborted'; r.ctrl.abort(); }
    this.records.clear();
    this.traffic = null;
    this.acc = 0;
  }

  store(rec) {
    this.records.set(rec.requestId, rec);
    if (this.records.size <= MAX_RECORDS) return;
    for (const [id, r] of this.records) {
      if (this.records.size <= MAX_RECORDS) break;
      if (r.state !== 'pending') this.records.delete(id);
    }
  }

  // ----- POST /api/send -----

  async send(body, internal = false) {
    if (!body || typeof body !== 'object') return bad('body must be a JSON object');
    const from = body.from || {};
    const node = this.c.nodes.get(from.nodeId);
    if (!node) return { status: 404, body: { error: E.error('UNKNOWN_NODE', 'node', `no sending node ${from.nodeId}`), correlationId: null } };
    const type = body.type === undefined ? 'request' : body.type;
    if (!['request', 'oneway', 'broadcast'].includes(type)) return bad(`type must be request, oneway or broadcast, not ${type}`);
    const to = body.to;
    if (!E.isAddr(to)) return bad('to needs nodeId and appId');
    const ttl = Number(body.ttlMs) > 0 ? Math.min(Number(body.ttlMs), MAX_TTL) : E.DEFAULT_TTL;
    const messageId = node.nextMessageId();
    const env = {
      proto: E.PROTO, version: E.VERSION, messageId, type,
      source: { nodeId: node.id, appId: typeof from.appId === 'string' && from.appId ? from.appId : 'echo', listenerId: from.listenerId ?? null },
      destination: { nodeId: to.nodeId, appId: to.appId, listenerId: to.listenerId ?? null },
      timestamp: node.now(), correlationId: messageId, ttlMs: ttl, payload: body.payload === undefined ? {} : body.payload,
    };
    if (body.msgTypeId !== undefined && body.msgTypeId !== null) env.msgTypeId = body.msgTypeId;
    if (to.nodeId === '*') env.scope = body.scope === 'all' ? 'all' : 'cluster';
    const rec = {
      requestId: `r-${++this.reqSeq}`, messageId, type, env, node, start: Date.now(), ctrl: new AbortController(),
      state: 'pending', result: null, userData: body.userData === undefined ? null : body.userData, epoch: this.c.epoch,
    };
    if (!internal) this.store(rec);
    if (type === 'request') node.pending += 1;
    const p = this.run(rec).finally(() => { if (type === 'request') node.pending -= 1; });
    if (body.async === true) {
      p.catch((e) => log(e && e.message));
      return { status: 202, body: { requestId: rec.requestId } };
    }
    const result = await p;
    return { status: 200, body: result || { requestId: rec.requestId, messageId, outcome: 'aborted' } };
  }

  async run(rec) {
    const { env, node } = rec;
    const signal = rec.ctrl.signal;
    let core;
    const problem = E.addressingProblem(env.type, env.destination);
    if (problem) core = { error: E.error('BAD_PROTOCOL', 'node', problem) };
    else if (E.size(env) > E.MAX_BYTES) core = { error: E.error('MESSAGE_TOO_LARGE', 'node', `envelope is ${E.size(env)} bytes, max ${E.MAX_BYTES}`) };
    else {
      const deadline = rec.start + env.ttlMs;
      const enabled = await node.waitEnabled(deadline, signal);
      if (signal.aborted) return null;
      if (!enabled) core = { error: E.error('TIMEOUT', 'node', `${node.id} stayed disabled for ${env.ttlMs} ms`) };
      else {
        env.timestamp = node.now();
        rec.route = node.route;
        node.countSent(env.type, env.type === 'broadcast' ? undefined : env.destination.nodeId);
        core = await this.dispatch(node, env, deadline, signal);
      }
    }
    if (signal.aborted || core.aborted || rec.epoch !== this.c.epoch) return null;
    return this.finish(rec, core);
  }

  finish(rec, core) {
    const { env, node } = rec;
    const latencyMs = Date.now() - rec.start;
    let outcome;
    if (core.error) outcome = rec.type === 'request' ? (core.error.code === 'TIMEOUT' ? 'timeout' : 'failure') : 'error';
    else outcome = { request: 'response', oneway: 'accepted', broadcast: 'broadcast' }[rec.type];
    const result = { requestId: rec.requestId, messageId: rec.messageId, outcome, latencyMs };
    if (outcome === 'response') result.response = core.response;
    if (outcome === 'broadcast') { result.delivered = core.delivered; result.failed = core.failed; }
    result.error = core.error || null;
    const peerId = env.destination.nodeId;
    if (core.error) node.countFailure(core.error.code, peerId);
    else if (core.failed) for (const f of core.failed) node.countFailure(f.code, f.nodeId);
    // A broadcast counts per destination once we know which ones were tried.
    if (rec.type === 'broadcast' && !core.error) for (const id of [...(core.delivered || []), ...(core.failed || []).map((f) => f.nodeId)]) node.countPeerSent('broadcast', id);
    if (outcome === 'response') node.countReceived('response', peerId);
    result.userData = rec.userData;
    const ok = !core.error && !(core.failed && core.failed.length);
    const mode = rec.route || node.route;
    const errorCode = core.error ? core.error.code : (core.failed && core.failed.length ? core.failed[0].code : null);
    this.c.metrics.record(mode, latencyMs, ok, errorCode);
    const dest = this.c.nodes.get(env.destination.nodeId);
    this.c.emit({
      type: `message.${rec.type}`, from: node.id, to: env.destination.nodeId, ok, latencyMs, errorCode, mode,
      messageId: rec.messageId, requestId: rec.requestId, appId: env.destination.appId, msgTypeId: env.msgTypeId ?? null,
      msgType: (dest && dest.msgTypeName(env.destination.appId, env.msgTypeId)) || node.msgTypeName(env.source.appId, env.msgTypeId),
    });
    rec.state = 'done';
    rec.result = result;
    return result;
  }

  // ----- dispatch -----

  async dispatch(node, env, deadline, signal) {
    const remaining = () => Math.max(1, deadline - Date.now());
    const d = env.destination;
    if (d.nodeId === '*') return this.broadcast(node, env, deadline, signal);
    if (node.route === 'gateway') {
      // Fast fail: a fresh gateway peer view says the destination is down or leaving (CONTRACT.md section 5).
      const v = node.peerView(d.nodeId, Date.now());
      if (v.state === 'unreachable' || v.state === 'disabled') {
        return { error: E.error('NODE_UNAVAILABLE', 'node', `gateway peer view of ${d.nodeId} is ${v.peerStatus}`) };
      }
      return this.viaGateway(node, env, remaining(), signal);
    }
    const target = this.c.nodes.get(d.nodeId);
    if (!target) return { error: E.error('UNKNOWN_NODE', 'node', `no node ${d.nodeId}`) };
    if (target.external) return this.viaGateway(node, env, remaining(), signal);
    if (target !== node) {
      const l = this.c.links.get(`${node.id}>${target.id}`);
      if (!l || !USABLE.has(l.state)) return { error: E.error('NODE_UNAVAILABLE', 'node', `link ${node.id}>${target.id} is ${l ? l.state : 'missing'}`) };
    }
    return this.direct(target.id, env, remaining(), signal);
  }

  async direct(targetId, env, timeoutMs, signal) {
    const r = await call('POST', `/t/farzad/n/${targetId}/deliver`, env, { timeoutMs, signal });
    if (r.aborted) return { aborted: true };
    if (r.timeout) return { error: E.error('TIMEOUT', 'node', `no answer from ${targetId} within ttlMs`) };
    if (r.neterr) return { error: E.error('NODE_UNAVAILABLE', targetId, `${targetId} did not answer`) };
    if (r.status === 200 && r.body && r.body.type === 'response') return { response: r.body };
    if (r.status === 202) return { accepted: true };
    if (r.body && r.body.error && r.body.error.code) return { error: r.body.error };
    return { error: E.error('NODE_UNAVAILABLE', targetId, `unexpected answer ${r.status}`) };
  }

  async viaGateway(node, env, timeoutMs, signal) {
    const c = this.c;
    if (!node.token) {
      const reg = await c.registerNode(node);
      if (!reg.ok) return { error: stripErr(reg.error) };
    }
    const used = node.token;
    let r = await gw.route(used, env, timeoutMs + 200, signal);
    if (r.status === 401) {
      // Register again only if no one did since this send took its token; otherwise retry with the new one.
      if (node.token === used) node.token = null;
      if (!node.token || node.registering) {
        const reg = await c.registerNode(node);
        if (!reg.ok) return { error: stripErr(reg.error) };
      }
      if (!node.token) return { error: E.error('NODE_UNAVAILABLE', 'gateway', `${node.id} is not registered with the gateway`) };
      r = await gw.route(node.token, env, timeoutMs + 200, signal);
    }
    if (r.aborted) return { aborted: true };
    const isBroadcast = env.destination.nodeId === '*';
    if (isBroadcast && (r.status === 200 || r.status === 202) && r.body && (Array.isArray(r.body.delivered) || typeof r.body.delivered === 'number')) {
      c.setGwLink(node, 'reachable');
      const failed = Array.isArray(r.body.failed) ? r.body.failed.filter((f) => f && typeof f.nodeId === 'string') : [];
      let delivered = r.body.delivered;
      if (!Array.isArray(delivered)) {
        // The gateway reports a count: the nodes in scope that did not fail are the delivered ones.
        const failedIds = new Set(failed.map((f) => f.nodeId));
        delivered = [...c.nodes.values()].filter((n) => n !== node && (env.scope === 'all' || !n.external) && !failedIds.has(n.id)).map((n) => n.id);
      }
      return { delivered, failed };
    }
    if (r.status === 200 && r.body && r.body.type === 'response') { c.setGwLink(node, 'reachable'); return { response: r.body }; }
    if (r.status === 202) { c.setGwLink(node, 'reachable'); return { accepted: true }; }
    const f = gw.failure(r);
    if (f.unreachable && node.token) c.setGwLink(node, 'unreachable');
    else if (node.token) c.setGwLink(node, 'reachable');
    return { error: stripErr(f) };
  }

  async broadcast(node, env, deadline, signal) {
    const c = this.c;
    const scopeAll = env.scope === 'all';
    const others = [...c.nodes.values()].filter((n) => n !== node && (scopeAll || !n.external));
    if (node.route === 'gateway') {
      const r = await this.viaGateway(node, env, Math.max(1, deadline - Date.now()), signal);
      if (r.aborted) return r;
      if (r.error) return { delivered: [], failed: others.map((n) => ({ nodeId: n.id, code: r.error.code })) };
      return r;
    }
    const peers = others.filter((n) => !n.external);
    const externals = others.filter((n) => n.external);
    const results = await Promise.all(peers.map(async (p) => {
      const l = c.links.get(`${node.id}>${p.id}`);
      if (!l || !USABLE.has(l.state)) return { nodeId: p.id, code: 'NODE_UNAVAILABLE' };
      const r = await this.direct(p.id, env, Math.max(1, deadline - Date.now()), signal);
      if (r.aborted) return { aborted: true };
      return r.error ? { nodeId: p.id, code: r.error.code } : { nodeId: p.id };
    }));
    if (signal.aborted) return { aborted: true };
    const delivered = results.filter((x) => !x.code).map((x) => x.nodeId);
    const failed = results.filter((x) => x.code);
    if (externals.length) {
      const ids = new Set(externals.map((n) => n.id));
      const r = await this.viaGateway(node, env, Math.max(1, deadline - Date.now()), signal);
      if (r.aborted) return r;
      if (r.error) for (const n of externals) failed.push({ nodeId: n.id, code: 'NODE_UNAVAILABLE' });
      else {
        for (const id of r.delivered) if (ids.has(id)) delivered.push(id);
        for (const f of r.failed) if (f && ids.has(f.nodeId)) failed.push(f);
      }
    }
    return { delivered, failed };
  }

  // ----- async results -----

  get(requestId) {
    const r = this.records.get(requestId);
    if (!r) return null;
    if (r.state === 'pending') return { requestId, messageId: r.messageId, outcome: 'pending' };
    if (r.state === 'aborted') return { requestId, messageId: r.messageId, outcome: 'aborted' };
    return r.result;
  }

  abort(requestId) {
    const r = this.records.get(requestId);
    if (!r) return { status: 404, body: { error: { message: `no request ${requestId}` } } };
    if (r.state !== 'pending') return { status: 409, body: { error: { message: `request ${requestId} is ${r.state}` }, outcome: r.result ? r.result.outcome : r.state } };
    r.state = 'aborted';
    r.ctrl.abort();
    this.c.emit({ type: 'request.aborted', from: r.node.id, to: r.env.destination.nodeId, ok: true, messageId: r.messageId, requestId, latencyMs: Date.now() - r.start });
    return { status: 200, body: { requestId, aborted: true } };
  }

  // ----- traffic generator -----

  setTraffic(b) {
    const rate = Math.max(0, Math.min(Number(b && b.rate) || 0, 500));
    if (!rate) { this.traffic = null; this.acc = 0; return { rate: 0 }; }
    const m = (b.mix && typeof b.mix === 'object') ? b.mix : {};
    const mix = { request: Math.max(0, Number(m.request) || 0), oneway: Math.max(0, Number(m.oneway) || 0), broadcast: Math.max(0, Number(m.broadcast) || 0) };
    if (!(mix.request + mix.oneway + mix.broadcast)) mix.request = 1;
    const payloadBytes = Math.max(0, Math.min(Number(b.payloadBytes) || 0, 60000));
    this.traffic = { rate, mix, payloadBytes, includeDown: b.includeDown === true };
    return this.traffic;
  }

  trafficTick() {
    const t = this.traffic;
    if (!t) return;
    this.acc = Math.min(this.acc + t.rate / 10, t.rate);
    while (this.acc >= 1 && this.trafficInflight < TRAFFIC_MAX_INFLIGHT) {
      this.acc -= 1;
      this.fireOne(t);
    }
  }

  fireOne(t) {
    const all = this.c.clusterNodes();
    const cluster = all.filter((n) => n.status === 'up');
    const senders = cluster.filter((n) => n.messaging === 'enabled');
    if (!senders.length) return;
    const from = senders[Math.floor(Math.random() * senders.length)];
    const total = t.mix.request + t.mix.oneway + t.mix.broadcast;
    let x = Math.random() * total;
    const type = (x -= t.mix.request) < 0 ? 'request' : (x -= t.mix.oneway) < 0 ? 'oneway' : 'broadcast';
    let to;
    if (type === 'broadcast') to = { nodeId: '*', appId: 'sink' };
    else {
      // includeDown: killed and restarting nodes stay destinations, so a failure shows up in the error rate.
      const dests = (t.includeDown ? all.filter((n) => n.status !== 'leaving') : cluster).filter((n) => n !== from);
      if (!dests.length) return;
      to = { nodeId: dests[Math.floor(Math.random() * dests.length)].id, appId: type === 'request' ? 'echo' : 'sink' };
    }
    this.trafficInflight += 1;
    const payload = { data: 'x'.repeat(t.payloadBytes) };
    this.send({ from: { nodeId: from.id, appId: 'echo' }, type, to, payload, ttlMs: E.DEFAULT_TTL }, true)
      .catch((e) => log(e && e.message))
      .finally(() => { this.trafficInflight -= 1; });
  }
}

module.exports = { Sender };
