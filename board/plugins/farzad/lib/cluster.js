'use strict';
// The cluster: nodes, mesh links and heartbeats, gateway registration, mode switch, chaos, state.
const { call } = require('./http');
const L = require('./links');
const gw = require('./gateway-client');
const { VirtualNode } = require('./node');
const { Events } = require('./events');
const { Metrics } = require('./metrics');

const MAX_NODES = 20;
const MIN_NODES = 3;
const HB_TIMEOUT_MS = 900;
const log = (...a) => console.error('[farzad]', ...a);

// Runs fn and reports, never throws: used for every timer callback and fire-and-forget promise.
function guard(fn) {
  try {
    const r = fn();
    if (r && typeof r.catch === 'function') r.catch((e) => log(e && e.message));
  } catch (e) { log(e && e.message); }
}

class Cluster {
  constructor() {
    this.events = new Events(2000);
    this.metrics = new Metrics();
    this.epoch = 0;
    this.nodes = new Map();
    this.links = new Map();
    this.mode = 'mesh';
    this.switching = false;
    this.nextNode = 1;
    this.hbSeq = 0;
    this.gwSeq = 0;
    this.gwResetDone = false;
    this.tickers = [];
    this.sender = null;
  }

  emit(e) { return this.events.emit({ mode: this.mode, ...e }); }

  later(ms, fn) { const t = setTimeout(() => guard(fn), ms); if (t.unref) t.unref(); return t; }

  start() {
    const every = (ms, fn) => { const t = setInterval(() => guard(fn), ms); if (t.unref) t.unref(); this.tickers.push(t); };
    every(L.HEARTBEAT.intervalMs, () => this.tick());
    every(100, () => this.fastTick());
  }

  stop() {
    for (const t of this.tickers) clearInterval(t);
    this.tickers = [];
    this.teardown();
  }

  // Stops everything that belongs to the current set of nodes.
  teardown() {
    this.epoch += 1;
    if (this.sender) this.sender.teardown();
    for (const n of this.nodes.values()) {
      if (n.restartTimer) clearTimeout(n.restartTimer);
      n.failAllWaiters();
      if (n.token) { const { token, id } = n; guard(() => gw.deregister(token, id)); }
    }
    this.nodes.clear();
    this.links.clear();
  }

  reset(count, mode) {
    this.teardown();
    this.metrics.reset();
    this.mode = mode;
    this.switching = false;
    this.nextNode = 1;
    this.gwResetDone = false;
    for (let i = 0; i < count; i += 1) this.createNode(false);
    this.emit({ type: 'mode.change', from: '*', to: '*', ok: true, reason: 'reset', nodes: count });
    if (mode === 'gateway') {
      // The gateway team asks for an admin reset before a gateway run; nodes register once it is done.
      this.gwResetDone = true;
      const ep = this.epoch;
      this.switching = true;
      guard(async () => {
        try { await gw.reset(); await this.gatewaySeq(); } finally { if (ep === this.epoch) this.switching = false; }
        if (ep === this.epoch) this.retryRegistrations();
      });
    }
    this.kick();
  }

  // ----- topology -----

  clusterNodes() { return [...this.nodes.values()].filter((n) => !n.external); }

  createNode(external) {
    const n = new VirtualNode(`n${this.nextNode}`, external, (e) => this.emit(e));
    this.nextNode += 1;
    n.route = external || this.mode === 'gateway' ? 'gateway' : 'mesh';
    this.nodes.set(n.id, n);
    if (!external && this.mode === 'mesh') {
      for (const o of this.clusterNodes()) {
        if (o === n) continue;
        this.addLink(n.id, o.id);
        this.addLink(o.id, n.id);
      }
    }
    this.emit({ type: 'node.up', from: n.id, to: n.id, ok: true, external: n.external });
    return n;
  }

  addLink(from, to) { const l = new L.Link(from, to); this.links.set(l.key, l); return l; }

  addNodes(count, external) {
    if (this.nodes.size + count > MAX_NODES) return { error: `at most ${MAX_NODES} nodes in total, have ${this.nodes.size}` };
    const ids = [];
    for (let i = 0; i < count; i += 1) ids.push(this.createNode(external).id);
    this.kick();
    return { ids };
  }

  async removeNode(n) {
    if (!n.external && this.clusterNodes().length <= MIN_NODES) return 'MIN_NODES';
    const ep = this.epoch;
    if (n.restartTimer) clearTimeout(n.restartTimer);
    const wasUp = n.status === 'up';
    n.status = 'leaving';
    this.recompute(n);
    this.emit({ type: 'node.leaving', from: n.id, to: n.id, ok: true });
    if (wasUp) {
      await this.announce(n, 'leaving');
      if (n.token) await gw.deregister(n.token, n.id);
    }
    if (ep !== this.epoch) return null;
    n.token = null;
    n.failAllWaiters();
    this.nodes.delete(n.id);
    for (const [k, l] of this.links) if (l.from === n.id || l.to === n.id) this.links.delete(k);
    return null;
  }

  // The node tells its mesh peers about a planned state change (restarting, leaving).
  announce(n, state) {
    if (n.external || n.route !== 'mesh') return Promise.resolve();
    const peers = this.clusterNodes().filter((o) => o !== n);
    return Promise.all(peers.map((o) => call('POST', `/t/farzad/n/${o.id}/heartbeat`, { from: n.id, seq: ++this.hbSeq, ts: n.now(), state }, { timeoutMs: 500 })));
  }

  // ----- link transitions and messaging -----

  apply(t) {
    if (!t) return;
    const { link, from, to, failure } = t;
    this.emit({ type: 'link.state', from: link.from, to: link.to, ok: to === 'reachable', state: to, prev: from });
    const a = this.nodes.get(link.from);
    const b = this.nodes.get(link.to);
    if (a) this.recompute(a);
    if (!b) return;
    if (to === 'reachable' && b.reportedDown) {
      b.reportedDown = false;
      this.emit({ type: 'node.up', from: link.from, to: b.id, ok: true });
    }
    if (failure && !b.reportedDown) {
      b.reportedDown = true;
      const ev = { type: 'node.down', from: link.from, to: b.id, ok: false, errorCode: 'NODE_UNAVAILABLE', detectMs: null };
      if (b.killTs !== null) {
        ev.detectMs = Date.now() - b.killTs;
        b.killTs = null;
        this.metrics.detect('mesh', ev.detectMs);
      }
      this.emit(ev);
    }
  }

  enabledFor(n) {
    if (n.status !== 'up' || n.forceDisabled) return false;
    if (n.external || n.route === 'gateway') return !!n.token;
    for (const l of this.links.values()) if (l.from === n.id && l.state === 'reachable') return true;
    return false;
  }

  recompute(n) { n.setMessaging(this.enabledFor(n)); }

  setGwLink(n, state) {
    const prev = n.gwLink.state;
    if (state === 'reachable') n.gwLink.lastContactTs = Date.now();
    if (prev === state) return;
    n.gwLink.state = state;
    this.emit({ type: 'link.state', from: n.id, to: 'gateway', ok: state === 'reachable', state, prev });
  }

  // ----- heartbeats -----

  kick() { if (this.mode === 'mesh') guard(() => this.heartbeatRound()); }

  tick() {
    if (this.mode === 'mesh') this.heartbeatRound();
    this.retryRegistrations();
    guard(() => this.pollGatewayDown());
  }

  fastTick() {
    const now = Date.now();
    for (const n of this.nodes.values()) n.expireWaiters(now);
    if (this.sender) this.sender.trafficTick();
  }

  heartbeatRound() {
    for (const l of this.links.values()) {
      const a = this.nodes.get(l.from);
      const b = this.nodes.get(l.to);
      if (!a || !b || a.status !== 'up' || l.inflight || l.state === 'disabled') continue;
      guard(() => this.beat(l, a, b));
    }
  }

  async beat(l, a, b) {
    l.inflight = true;
    const ep = this.epoch;
    const sentTs = a.now();
    let r;
    try {
      r = await call('POST', `/t/farzad/n/${b.id}/heartbeat`, { from: a.id, seq: ++this.hbSeq, ts: sentTs, state: 'up' }, { timeoutMs: HB_TIMEOUT_MS });
    } finally { l.inflight = false; }
    if (ep !== this.epoch || this.links.get(l.key) !== l || a.status !== 'up' || this.mode !== 'mesh') return;
    if (r.status === 200 && r.body && r.body.nodeId === b.id) this.apply(L.onAnswer(l, sentTs, r.body.receivedTs, r.body.ts, a.now()));
    else this.apply(L.onMiss(l, Date.now()));
  }

  // A heartbeat arrived at node n (from a peer or from the gateway).
  onHeartbeat(n, body) {
    if (!body || typeof body !== 'object') return;
    if (body.from === 'gateway') {
      n.lastProbeTs = Date.now();
      if (n.token) this.setGwLink(n, 'reachable');
      return;
    }
    const l = this.links.get(`${n.id}>${body.from}`);
    if (l && (body.state === 'restarting' || body.state === 'leaving')) this.apply(L.onPeerState(l, body.state, Date.now()));
  }

  // ----- gateway registration -----

  async registerNode(n) {
    const ep = this.epoch;
    n.registering = true;
    n.lastRegisterTs = Date.now();
    this.setGwLink(n, 'initializing');
    let r;
    try { r = await gw.register(n); } finally { n.registering = false; }
    if (ep !== this.epoch || !this.nodes.has(n.id)) return r;
    if (r.ok && n.status === 'up') this.adopt(n, r);
    else if (!r.ok) {
      this.setGwLink(n, r.error.unreachable ? 'unreachable' : 'disabled');
    }
    this.recompute(n);
    return r;
  }

  // A successful registration: new token, and the gateway's probe interval for the silence check.
  adopt(n, r) {
    n.token = r.token;
    n.probeIntervalMs = r.probeIntervalMs;
    n.lastProbeTs = Date.now();
    this.setGwLink(n, 'reachable');
  }

  // The gateway lost us (for example after a revive) when its probes stopped for 3 intervals.
  probeSilent(n, now) {
    return n.token && n.status === 'up' && !n.registering && !this.switching
      && (n.external || (n.route === 'gateway' && this.mode === 'gateway'))
      && now - n.lastProbeTs > 3 * n.probeIntervalMs;
  }

  needsRegistration(n) {
    return n.status === 'up' && !n.token && !n.registering && (n.external || (n.route === 'gateway' && this.mode === 'gateway' && !this.switching));
  }

  retryRegistrations() {
    const now = Date.now();
    for (const n of this.nodes.values()) {
      if (this.needsRegistration(n) && now - n.lastRegisterTs >= 1000) guard(() => this.registerNode(n));
      else if (this.probeSilent(n, now)) guard(() => this.registerNode(n));
    }
  }

  // Gateway mode: the gateway's down reports give detectMs for killed nodes.
  async pollGatewayDown() {
    if (this.mode !== 'gateway') return;
    if (![...this.nodes.values()].some((n) => n.killTs !== null)) return;
    const ep = this.epoch;
    const r = await gw.events(this.gwSeq);
    if (ep !== this.epoch || r.status !== 200 || !r.body || !Array.isArray(r.body.events)) return;
    if (typeof r.body.seq === 'number') this.gwSeq = r.body.seq;
    for (const e of r.body.events) {
      const kind = e && (e.type || e.kind);
      if (kind !== 'node.down' && kind !== 'node-down') continue;
      const n = this.nodes.get(e.to);
      if (!n || n.killTs === null || (typeof e.ts === 'number' && e.ts < n.killTs)) continue;
      const detectMs = typeof e.detectMs === 'number' ? e.detectMs : (typeof e.ts === 'number' ? e.ts : Date.now()) - n.killTs;
      n.killTs = null;
      n.reportedDown = true;
      this.metrics.detect('gateway', detectMs);
      this.emit({ type: 'node.down', from: 'gateway', to: n.id, ok: false, errorCode: 'NODE_UNAVAILABLE', detectMs });
    }
  }

  async gatewaySeq() {
    const r = await gw.events(0);
    if (r.status === 200 && r.body && typeof r.body.seq === 'number') this.gwSeq = r.body.seq;
  }

  // ----- mode switch (CONTRACT.md section 4) -----

  async switchMode(target) {
    if (this.switching) return { status: 502, body: { error: { code: 'MODE_SWITCH_FAILED', reason: 'busy', at: 'node', message: 'a mode switch is already running' }, failed: [] } };
    if (target === this.mode) return { status: 200, body: { mode: this.mode, switchMs: 0, failed: [] } };
    const start = Date.now();
    const ep = this.epoch;
    this.switching = true;
    try {
      return target === 'gateway' ? await this.toGateway(start, ep) : await this.toMesh(start, ep);
    } finally {
      if (ep === this.epoch) this.switching = false;
    }
  }

  async toGateway(start, ep) {
    const cluster = this.clusterNodes();
    for (const n of cluster) { n.forceDisabled = true; this.recompute(n); }
    if (!this.gwResetDone) {
      this.gwResetDone = true;
      await gw.reset();
      for (const n of this.nodes.values()) if (n.external && n.token) { n.token = null; this.setGwLink(n, 'disabled'); }
    }
    await this.gatewaySeq();
    if (ep !== this.epoch) return { status: 502, body: { error: { code: 'MODE_SWITCH_FAILED', at: 'node', message: 'cluster was reset' }, failed: [] } };
    const up = cluster.filter((n) => n.status === 'up');
    const results = await Promise.all(up.map(async (n) => {
      const r = await gw.register(n);
      if (r.ok && ep === this.epoch && n.status === 'up') {
        this.adopt(n, r);
        n.route = 'gateway';
        n.forceDisabled = false;
        this.recompute(n);
      } else if (!r.ok) this.setGwLink(n, r.error.unreachable ? 'unreachable' : 'disabled');
      return { n, r };
    }));
    if (ep !== this.epoch) return { status: 502, body: { error: { code: 'MODE_SWITCH_FAILED', at: 'node', message: 'cluster was reset' }, failed: [] } };
    const failed = results.filter((x) => !x.r.ok).map((x) => ({ nodeId: x.n.id, code: x.r.error.code }));
    const switchMs = Date.now() - start;
    if (up.length && failed.length === up.length) {
      for (const n of cluster) { n.forceDisabled = false; n.route = 'mesh'; this.setGwLink(n, 'disabled'); this.recompute(n); }
      this.emit({ type: 'mode.change', from: 'mesh', to: 'gateway', ok: false, errorCode: 'MODE_SWITCH_FAILED', switchMs, failed });
      return { status: 502, body: { error: { code: 'MODE_SWITCH_FAILED', at: 'gateway', message: 'the gateway accepted no registration' }, mode: 'mesh', switchMs, failed } };
    }
    this.mode = 'gateway';
    for (const n of cluster) { n.route = 'gateway'; n.forceDisabled = false; this.recompute(n); }
    for (const [k, l] of this.links) { this.links.delete(k); l.state = 'disabled'; }
    this.emit({ type: 'mode.change', from: 'mesh', to: 'gateway', ok: true, switchMs, failed });
    return { status: 200, body: { mode: 'gateway', switchMs, failed } };
  }

  async toMesh(start, ep) {
    const cluster = this.clusterNodes();
    for (const n of cluster) { n.forceDisabled = true; this.recompute(n); }
    await Promise.all(cluster.map(async (n) => {
      if (!n.token) return;
      const { token } = n;
      n.token = null;
      if (n.status === 'up') {
        const r = await gw.deregister(token, n.id);
        if (r.status !== 200) log(`deregister ${n.id} failed (${r.status}), ignored`);
      }
      this.setGwLink(n, 'disabled');
    }));
    if (ep !== this.epoch) return { status: 502, body: { error: { code: 'MODE_SWITCH_FAILED', at: 'node', message: 'cluster was reset' }, failed: [] } };
    this.mode = 'mesh';
    for (const a of cluster) for (const b of cluster) if (a !== b) this.addLink(a.id, b.id);
    for (const n of cluster) { n.route = 'mesh'; n.forceDisabled = false; this.recompute(n); }
    const switchMs = Date.now() - start;
    this.emit({ type: 'mode.change', from: 'gateway', to: 'mesh', ok: true, switchMs, failed: [] });
    this.kick();
    return { status: 200, body: { mode: 'mesh', switchMs, failed: [] } };
  }

  // ----- chaos (CONTRACT.md section 4) -----

  chaos(n, b) {
    const action = b.action;
    switch (action) {
      case 'kill':
        if (n.status === 'down') break;
        if (n.restartTimer) { clearTimeout(n.restartTimer); n.restartTimer = null; }
        n.status = 'down';
        n.killTs = Date.now();
        this.goneQuiet(n);
        break;
      case 'revive':
        if (n.status === 'up' || n.status === 'leaving') break;
        if (n.restartTimer) { clearTimeout(n.restartTimer); n.restartTimer = null; }
        this.comeBack(n);
        break;
      case 'restart': {
        if (n.status !== 'up') return 'node is not up';
        const downMs = Number.isFinite(Number(b.downMs)) && Number(b.downMs) >= 0 ? Math.min(Number(b.downMs), 120000) : 3000;
        const ep = this.epoch;
        this.emit({ type: 'node.restarting', from: n.id, to: n.id, ok: true, downMs });
        guard(async () => {
          await this.announce(n, 'restarting');
          if (ep !== this.epoch || n.status !== 'up') return;
          n.status = 'restarting';
          this.goneQuiet(n);
          n.restartTimer = this.later(downMs, () => { n.restartTimer = null; if (ep === this.epoch && n.status === 'restarting') this.comeBack(n); });
        });
        break;
      }
      case 'slow': n.chaos.delayMs = Math.max(0, Math.min(Number(b.delayMs) || 0, 60000)); break;
      case 'drop': n.chaos.dropPercent = Math.max(0, Math.min(Number(b.percent) || 0, 100)); break;
      case 'skew': n.chaos.skewMs = Math.max(-3600000, Math.min(Number(b.skewMs) || 0, 3600000)); break;
      case 'clear': n.chaos = { delayMs: 0, dropPercent: 0, skewMs: 0 }; break;
      default: return `unknown action ${action}`;
    }
    this.emit({ type: 'chaos', from: n.id, to: n.id, ok: true, action, chaos: { ...n.chaos }, status: n.status });
    return null;
  }

  // The node stops sending: its own links and its gateway link go down (not a failure).
  goneQuiet(n) {
    for (const l of this.links.values()) if (l.from === n.id) this.apply(L.forceDown(l));
    if (n.token) this.setGwLink(n, 'unreachable');
    this.recompute(n);
  }

  comeBack(n) {
    n.status = 'up';
    n.killTs = null;
    for (const l of this.links.values()) if (l.from === n.id) this.apply(L.forceDown(l));
    if (n.route === 'gateway' || n.external) {
      n.token = null;
      n.lastRegisterTs = 0;
      this.setGwLink(n, 'disabled');
    }
    this.recompute(n);
    this.emit({ type: 'node.up', from: n.id, to: n.id, ok: true });
    if (n.route === 'gateway' || n.external) {
      if (this.mode === 'gateway' && !this.switching) guard(() => this.registerNode(n));
    } else this.kick();
  }

  // ----- state (CONTRACT.md section 5) -----

  state() {
    const all = [...this.nodes.values()];
    const links = [];
    let possible = 0;
    if (this.mode === 'mesh') {
      for (const l of this.links.values()) links.push(l.view());
      const c = all.filter((n) => !n.external).length;
      possible = c * (c - 1);
    }
    for (const n of all) {
      if (this.mode !== 'gateway' && !n.external) continue;
      links.push({ from: n.id, to: 'gateway', state: n.gwLink.state, clockSync: null, offsetMs: null, lastHeartbeatTs: n.gwLink.lastContactTs });
      possible += 1;
    }
    return {
      mode: this.mode,
      switching: this.switching,
      heartbeat: { ...L.HEARTBEAT },
      maxMessageBytes: 65536,
      nodes: all.map((n) => n.view()),
      links,
      possibleLinks: possible,
      openConnections: links.filter((l) => l.state === 'reachable').length,
      metrics: { mesh: this.metrics.snapshot('mesh'), gateway: this.metrics.snapshot('gateway') },
    };
  }
}

module.exports = { Cluster, MAX_NODES, MIN_NODES, guard };
