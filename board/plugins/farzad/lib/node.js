'use strict';
// One virtual node: applications and listeners, receiving (deliver), duplicate suppression,
// messaging enabled/disabled with a queue of waiting sends, and the heartbeat answer.
const E = require('./envelope');

const DEDUP_MAX = 256;
const DEDUP_MS = 60000;
const INFLIGHT_LIMIT = 50;
const QUEUE_MAX = 1000;
const TYPES = ['request', 'response', 'oneway', 'broadcast'];
const zero = () => Object.fromEntries(TYPES.map((t) => [t, 0]));
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });

class VirtualNode {
  constructor(id, external, emit) {
    this.id = id;
    this.external = !!external;
    this.emit = emit;
    this.status = 'up';
    this.messaging = 'disabled';
    this.inflight = 0;
    this.counter = 0;
    this.apps = new Map();
    this.chaos = { delayMs: 0, dropPercent: 0, skewMs: 0 };
    this.dedup = new Map();
    this.dedupHits = 0;
    this.pending = 0;
    this.counters = { sent: zero(), received: zero(), failures: {} };
    this.waiters = [];
    this.route = 'mesh';
    this.forceDisabled = false;
    this.token = null;
    this.registering = false;
    this.lastRegisterTs = 0;
    this.lastProbeTs = 0;
    this.probeIntervalMs = 1000;
    this.gwLink = { state: 'disabled', lastContactTs: null };
    this.killTs = null;
    this.reportedDown = false;
    this.restartTimer = null;
    this.addApp('echo', null, {}, 'echo');
    this.addApp('sink', null, {}, 'sink');
  }

  now() { return Date.now() + (this.chaos.skewMs || 0); }

  nextMessageId() { this.counter += 1; return `${this.id}-${this.counter}`; }

  addApp(appId, listenerId, msgTypes, kind) {
    let app = this.apps.get(appId);
    if (!app) { app = { appId, kind: kind || 'echo', listenerIds: new Set(), msgTypes: {} }; this.apps.set(appId, app); }
    if (listenerId) app.listenerIds.add(String(listenerId));
    if (msgTypes && typeof msgTypes === 'object') for (const [k, v] of Object.entries(msgTypes)) app.msgTypes[String(k)] = String(v);
    return app;
  }

  // Removes a listener, or the whole application when no listenerId is given.
  removeApp(appId, listenerId) {
    const app = this.apps.get(appId);
    if (!app) return E.error('UNKNOWN_APP', this.id, `no application ${appId} on ${this.id}`);
    if (listenerId) {
      if (!app.listenerIds.delete(listenerId)) return E.error('NO_LISTENER', this.id, `no listener ${listenerId}`);
    } else this.apps.delete(appId);
    return null;
  }

  appList() {
    return [...this.apps.values()].map((a) => ({ appId: a.appId, listenerIds: [...a.listenerIds], msgTypes: { ...a.msgTypes } }));
  }

  msgTypeName(appId, msgTypeId) {
    if (msgTypeId === undefined || msgTypeId === null) return null;
    const app = this.apps.get(appId);
    return (app && app.msgTypes[String(msgTypeId)]) || null;
  }

  countSent(type) { if (type in this.counters.sent) this.counters.sent[type] += 1; }

  countFailure(code) { const f = this.counters.failures; const k = code || 'UNKNOWN'; f[k] = (f[k] || 0) + 1; }

  view(now) {
    const c = this.counters;
    const gwRoute = this.external || this.route === 'gateway';
    return {
      nodeId: this.id, external: this.external, status: this.status, messaging: this.messaging, inflight: this.inflight, apps: this.appList(), chaos: { ...this.chaos },
      limits: { inflight: INFLIGHT_LIMIT },
      queued: this.waiters.length,
      pending: this.pending,
      dedup: { size: this.dedup.size, hits: this.dedupHits },
      gateway: { registered: !!this.token, lastProbeAgeMs: gwRoute && this.token && this.lastProbeTs ? now - this.lastProbeTs : null },
      counters: { sent: { ...c.sent }, received: { ...c.received }, failures: { ...c.failures } },
    };
  }

  // ----- messaging enabled / queued sends -----

  setMessaging(enabled) {
    const next = enabled ? 'enabled' : 'disabled';
    if (this.messaging === next) return;
    this.messaging = next;
    this.emit({ type: `messaging.${next}`, from: this.id, to: this.id, ok: enabled });
    if (enabled) {
      const w = this.waiters;
      this.waiters = [];
      for (const x of w) x.resolve(true);
    }
  }

  // Resolves true when the node is enabled, false when the deadline passes or the send is aborted.
  waitEnabled(deadline, signal) {
    if (this.messaging === 'enabled') return Promise.resolve(true);
    if (this.waiters.length >= QUEUE_MAX || Date.now() >= deadline) return Promise.resolve(false);
    return new Promise((resolve) => {
      const w = { deadline, resolve: (v) => { if (signal) signal.removeEventListener('abort', onAbort); resolve(v); } };
      const onAbort = () => { this.waiters = this.waiters.filter((x) => x !== w); resolve(false); };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(w);
    });
  }

  expireWaiters(now) {
    if (!this.waiters.length) return;
    const keep = [];
    for (const w of this.waiters) if (w.deadline <= now) w.resolve(false); else keep.push(w);
    this.waiters = keep;
  }

  failAllWaiters() { const w = this.waiters; this.waiters = []; for (const x of w) x.resolve(false); }

  // ----- receiving -----

  heartbeatAnswer(body, receivedTs) {
    return { nodeId: this.id, seq: body && body.seq !== undefined ? body.seq : null, receivedTs, ts: this.now(), state: this.status === 'up' ? 'up' : this.status };
  }

  pruneDedup(now) {
    for (const [id, d] of this.dedup) {
      if (now - d.ts > DEDUP_MS || this.dedup.size > DEDUP_MAX) this.dedup.delete(id); else break;
    }
  }

  // Delivers a parsed envelope. Returns {status, body}.
  async deliver(env) {
    const problem = E.validate(env);
    if (problem) return this.fail(E.error('BAD_PROTOCOL', this.id, problem), env);
    if (env.type === 'response') return this.fail(E.error('BAD_PROTOCOL', this.id, 'responses travel in the HTTP answer'), env);
    if (env.destination.nodeId !== '*' && env.destination.nodeId !== this.id) {
      return this.fail(E.error('UNKNOWN_NODE', this.id, `this is ${this.id}, not ${env.destination.nodeId}`), env);
    }
    const now = Date.now();
    this.pruneDedup(now);
    const seen = this.dedup.get(env.messageId);
    if (seen) {
      this.dedupHits += 1;
      if (env.type === 'request') return seen.promise;
      return { status: 202, body: { accepted: true, duplicate: true } };
    }
    if (env.type in this.counters.received) this.counters.received[env.type] += 1;
    const promise = this.process(env);
    this.dedup.set(env.messageId, { ts: now, promise });
    this.pruneDedup(now);
    return promise;
  }

  fail(err, env) {
    return { status: E.statusOf(err), body: { error: err, correlationId: (env && typeof env.messageId === 'string') ? env.messageId : null } };
  }

    // In-flight accounting (PEER_OVERLOADED) is done by the deliver endpoint, so that messages held by slow chaos count.
  async process(env) {
    const d = env.destination;
    let targets;
    if (d.appId === '*') targets = [...this.apps.values()];
    else {
      const app = this.apps.get(d.appId);
      if (!app) return this.fail(E.error('UNKNOWN_APP', this.id, `no application ${d.appId} on ${this.id}`), env);
      if (d.listenerId != null && !app.listenerIds.has(d.listenerId)) return this.fail(E.error('NO_LISTENER', this.id, `no listener ${d.listenerId}`), env);
      targets = [app];
    }
    if (env.type !== 'request') return { status: 202, body: { accepted: true } };
    // A request is answered by the first application that answers; sink never answers.
    if (!targets.some((a) => a.kind !== 'sink')) {
      await sleep(Math.min(env.ttlMs || E.DEFAULT_TTL, 30000));
      return this.fail(E.error('TIMEOUT', this.id, `${d.appId} does not answer requests`), env);
    }
    return { status: 200, body: this.response(env) };
  }

  response(req) {
    const r = {
      proto: E.PROTO, version: E.VERSION, messageId: this.nextMessageId(), type: 'response',
      source: { nodeId: this.id, appId: req.destination.appId, listenerId: req.destination.listenerId ?? null },
      destination: { nodeId: req.source.nodeId, appId: req.source.appId, listenerId: req.source.listenerId ?? null },
      timestamp: this.now(), correlationId: req.messageId, ttlMs: req.ttlMs ?? E.DEFAULT_TTL, payload: req.payload ?? null,
    };
    if (req.msgTypeId !== undefined && req.msgTypeId !== null) r.msgTypeId = req.msgTypeId;
    this.countSent('response');
    return r;
  }
}

module.exports = { VirtualNode, INFLIGHT_LIMIT };
