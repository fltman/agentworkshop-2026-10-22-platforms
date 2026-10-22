'use strict';
// NodeLink gateway core (contract: projects/pisak/CONTRACT.md v0.2).
// Every public method returns { status, body, headers? } and never throws for client input.

const crypto = require('crypto');
const { Events, Metrics, percentile } = require('./telemetry');

const DEFAULTS = {
  defaultTtlMs: 2000, retries: 2, breakerFailures: 5, breakerOpenMs: 5000,
  rateLimitPerSec: 50, rateLimitBurst: 100, probeIntervalMs: 1000, probeTimeoutMs: 3000, slowThresholdMs: 500,
};
const LIMITS = {
  defaultTtlMs: [50, 60000], retries: [0, 5], breakerFailures: [1, 1000], breakerOpenMs: [100, 600000],
  rateLimitPerSec: [1, 100000], rateLimitBurst: [1, 100000], probeIntervalMs: [100, 60000],
  probeTimeoutMs: [200, 600000], slowThresholdMs: [1, 60000],
};
const MAX_NODES = 50;
const MAX_APPS = 32;
const RECENT = 20;
const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
// Only team paths on the board's own origin: the gateway must not be usable to POST to arbitrary hosts or to
// the board's own API. No '%' (the URL parser treats %2e%2e as ..), no '.'/'..' segments, no empty segments.
const PATH_RE = /^\/t\/[A-Za-z0-9_.~-]+(\/[A-Za-z0-9_.~-]+)*$/;
const isTeamPath = p => typeof p === 'string' && p.length <= 200 && PATH_RE.test(p)
  && !p.startsWith('/t/pisak/') && !p.split('/').some(s => s === '.' || s === '..') && new URL(p, 'http://x').pathname === p;
const TYPES = new Set(['request', 'response', 'oneway', 'broadcast']);
// farzad's section 2. Node answers with one of these codes are passed through to the sender unchanged.
const PROTOCOL_CODES = new Set(['UNKNOWN_NODE', 'UNKNOWN_APP', 'NO_LISTENER', 'TIMEOUT', 'NODE_UNAVAILABLE',
  'PEER_OVERLOADED', 'MESSAGE_TOO_LARGE', 'REJECTED', 'BAD_PROTOCOL']);
const MAX_MESSAGE_BYTES = 65536;
const MIN_TTL_MS = 50;
const RESTART_GRACE_MS = 10000;

const sleep = ms => new Promise(r => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });

function fail(status, code, message, reason = null, headers) {
  return { ok: false, status, code, body: { error: { code, reason, at: 'gateway', message } }, headers };
}
// A client bug caught by the gateway itself: counted in badRequests, not as a routed message.
const badRequest = msg => ({ ...fail(400, 'BAD_PROTOCOL', msg), local: true });
const authFail = msg => fail(401, 'REJECTED', msg, 'auth');

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

class Gateway {
  // `shared` lets an HA pair use one event stream and one metrics window, so cursors survive a failover.
  constructor(id = 'a', shared = {}) {
    this.id = id;
    this.config = { ...DEFAULTS };
    this.nodes = new Map();
    this.events = shared.events || new Events();
    this.metrics = shared.metrics || new Metrics();
    this.status = 'up';
    this.startedAt = Date.now();
    this.killedAt = 0;
    this.routes = 0; // authenticated route calls since the process started; admin reset does not clear it
    // Loopback to the board's own port (spore backend-4): never derived from the Host header. Without PORT, index.js
    // learns it from the first request's local port.
    this.baseUrl = process.env.PORT ? `http://127.0.0.1:${process.env.PORT}` : null;
  }

  url(path) { return (this.baseUrl || `http://127.0.0.1:${process.env.PORT || 8180}`) + path; }

  gatewayDown() { return fail(503, 'NODE_UNAVAILABLE', `gateway ${this.id} is down`, 'gateway_down'); }

  // ---------- registry ----------

  register(body) {
    if (this.status !== 'up') return this.gatewayDown();
    if (!body || typeof body !== 'object') return badRequest('body must be a JSON object');
    const { nodeId, deliverUrl } = body;
    const rawApps = body.apps !== undefined ? body.apps : body.appIds;
    if (!ID_RE.test(nodeId || '')) return badRequest('nodeId must be 1-64 chars of [A-Za-z0-9_.:-]');
    // apps: ["echo"] or [{appId: "echo", listenerIds: [...]}] (farzad section 6). Listeners are the node's business.
    const apps = Array.isArray(rawApps) ? rawApps.map(a => (a && typeof a === 'object' ? a.appId : a)) : null;
    if (!apps || !apps.length || apps.length > MAX_APPS || !apps.every(a => typeof a === 'string' && ID_RE.test(a))) {
      return badRequest(`apps must be a non-empty array (max ${MAX_APPS}) of app ids or {appId} objects`);
    }
    if (body.external !== undefined && typeof body.external !== 'boolean') return badRequest('external must be a boolean');
    if (!isTeamPath(deliverUrl)) return badRequest('deliverUrl must be a path on this origin, starting with /t/');
    let heartbeatUrl = body.heartbeatUrl;
    if (heartbeatUrl === undefined || heartbeatUrl === null) {
      heartbeatUrl = deliverUrl.endsWith('/deliver') ? deliverUrl.slice(0, -'deliver'.length) + 'heartbeat' : null;
    } else if (!isTeamPath(heartbeatUrl)) {
      return badRequest('heartbeatUrl must be a path on this origin, starting with /t/');
    }
    if (!this.nodes.has(nodeId) && this.nodes.size >= MAX_NODES) return badRequest(`registry full (${MAX_NODES} nodes)`);

    const now = Date.now();
    const node = this.makeNode({
      nodeId, apps: [...new Set(apps)], deliverUrl, heartbeatUrl, external: body.external === true,
      token: 'gw-tok-' + crypto.randomBytes(16).toString('hex'), registeredAt: now,
    }, now);
    this.nodes.set(nodeId, node);
    this.events.emit('node-registered', { from: nodeId, to: 'gateway', ok: true, nodeId, apps: node.apps, external: node.external });
    return { status: 200, body: { token: node.token, probeIntervalMs: this.config.probeIntervalMs, probeTimeoutMs: this.config.probeTimeoutMs } };
  }

  makeNode(id, now) {
    return {
      ...id, status: 'up', slow: false, graceUntil: 0, leaving: false,
      lastSeen: now, lastProbeAt: 0, probing: false, probeFailures: 0, probeSeq: 0,
      breaker: { state: 'closed', failures: 0, openedAt: 0, trial: false },
      bucket: { tokens: this.config.rateLimitBurst, last: now }, lastRateEvent: 0,
      recent: [], inFlight: 0,
    };
  }

  // ---------- HA replication (used by ha.js) ----------

  // What a standby needs to take over without re-registration: identity, token and planned state.
  snapshot() {
    return [...this.nodes.values()].map(n => ({
      nodeId: n.nodeId, apps: n.apps, deliverUrl: n.deliverUrl, heartbeatUrl: n.heartbeatUrl, external: n.external,
      token: n.token, registeredAt: n.registeredAt, graceUntil: n.graceUntil, leaving: n.leaving, probeSeq: n.probeSeq,
    }));
  }

  // Every restored node counts as just seen: the new active's own probes decide who is down.
  restore(list) {
    const now = Date.now();
    this.nodes = new Map(list.map(s => {
      const { graceUntil, leaving, probeSeq, ...id } = s;
      return [s.nodeId, Object.assign(this.makeNode(id, now), { graceUntil, leaving, probeSeq })];
    }));
  }

  // Returns the node when `req` carries the token of `nodeId`, otherwise a 401 result.
  authenticate(req, nodeId) {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    if (!m) return authFail('missing Authorization: Bearer <token>');
    const node = this.nodes.get(nodeId);
    if (!node || !safeEqual(node.token, m[1])) return authFail(`token does not belong to ${nodeId}`);
    return node;
  }

  anyToken(req) {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    if (!m) return authFail('missing Authorization: Bearer <token>');
    for (const n of this.nodes.values()) if (safeEqual(n.token, m[1])) return n;
    return authFail('unknown token');
  }

  heartbeat(req, body) {
    if (this.status !== 'up') return this.gatewayDown();
    const node = this.authenticate(req, body && (body.nodeId || body.from));
    if (node.ok === false) return node;
    this.markAlive(node);
    this.applyState(node, body.state);
    return { status: 200, body: { ok: true } };
  }

  deregister(req, body) {
    if (this.status !== 'up') return this.gatewayDown();
    const node = this.authenticate(req, body && body.nodeId);
    if (node.ok === false) return node;
    this.nodes.delete(node.nodeId);
    this.events.emit('node-deregistered', { from: node.nodeId, to: 'gateway', ok: true, nodeId: node.nodeId });
    return { status: 200, body: { ok: true } };
  }

  listNodes(req) {
    if (this.status !== 'up') return this.gatewayDown();
    const caller = this.anyToken(req);
    if (caller.ok === false) return caller;
    return { status: 200, body: { nodes: [...this.nodes.values()].map(n => ({ nodeId: n.nodeId, apps: n.apps, status: this.nodeStatus(n) })) } };
  }

  nodeStatus(n) {
    if (n.status === 'down') return 'down';
    if (n.leaving) return 'leaving';
    if (n.graceUntil > Date.now()) return 'restarting';
    return n.slow ? 'slow' : 'up';
  }

  // Membership as the gateway sees it, sent with every probe so nodes keep per-peer state in gateway mode.
  peersOf(node) {
    const peers = {};
    for (const n of this.nodes.values()) if (n !== node) peers[n.nodeId] = this.nodeStatus(n);
    return peers;
  }

  // farzad's heartbeat state: a planned restart or leave is not a failure, so it must not raise node-down.
  applyState(node, state) {
    if (state === 'restarting') {
      if (!(node.graceUntil > Date.now())) this.events.emit('node-restarting', { from: node.nodeId, to: 'gateway', ok: true, nodeId: node.nodeId });
      node.graceUntil = Date.now() + RESTART_GRACE_MS;
      node.leaving = false;
    } else if (state === 'leaving') {
      if (!node.leaving) this.events.emit('node-leaving', { from: node.nodeId, to: 'gateway', ok: true, nodeId: node.nodeId });
      node.leaving = true;
    } else if (state === 'up') {
      node.graceUntil = 0;
      node.leaving = false;
    }
  }

  markAlive(node) {
    node.lastSeen = Date.now();
    if (node.status === 'down') {
      node.status = 'up';
      this.events.emit('node-up', { from: 'gateway', to: node.nodeId, ok: true, nodeId: node.nodeId });
    }
  }

  // ---------- routing ----------

  async route(req, body) {
    const t0 = Date.now();
    const env = body && typeof body === 'object' ? body : null;
    const correlationId = env && typeof env.messageId === 'string' ? env.messageId : null;
    const out = await this.routeInner(req, env, t0);
    if (out.local) this.metrics.badRequests++;
    else if (env) this.finish(env, out, Date.now() - t0);
    if (!out.ok && out.body && out.body.error) out.body = { ...out.body, correlationId: out.body.correlationId || correlationId };
    return out;
  }

  async routeInner(req, env, t0) {
    if (this.status !== 'up') return this.gatewayDown();
    const problem = validateEnvelope(env);
    if (problem) return badRequest(problem);
    if (env.type === 'response') return badRequest('responses travel back in the HTTP answer to the request; do not route them');
    const bytes = Buffer.byteLength(JSON.stringify(env));
    if (bytes > MAX_MESSAGE_BYTES) return { ...fail(413, 'MESSAGE_TOO_LARGE', `envelope is ${bytes} bytes, max ${MAX_MESSAGE_BYTES}`), local: true };

    const src = this.authenticate(req, env.source.nodeId);
    if (src.ok === false) return src;
    this.routes++;
    this.markAlive(src);

    const waitMs = this.takeToken(src);
    if (waitMs > 0) {
      this.metrics.rateLimited++;
      if (t0 - src.lastRateEvent > 1000) {
        src.lastRateEvent = t0;
        this.events.emit('rate-limited', { from: src.nodeId, to: 'gateway', ok: false, errorCode: 'REJECTED', nodeId: src.nodeId });
      }
      return fail(429, 'REJECTED', `rate limit ${this.config.rateLimitPerSec}/s exceeded for ${src.nodeId}`, 'rate_limit',
        { 'retry-after': String(Math.max(1, Math.ceil(waitMs / 1000))) });
    }

    const ttl = Number.isFinite(env.ttlMs) && env.ttlMs > 0 ? Math.min(Math.max(env.ttlMs, MIN_TTL_MS), 60000) : this.config.defaultTtlMs;
    const deadline = t0 + ttl;
    // A timeout only says something about the receiver if the sender gave it at least the gateway's own budget.
    const fair = ttl >= this.config.defaultTtlMs;
    if (env.type === 'broadcast') return this.broadcast(env, src, deadline, fair);

    const dest = this.nodes.get(env.destination.nodeId);
    if (!dest) return fail(404, 'UNKNOWN_NODE', `${env.destination.nodeId} is not registered`);
    if (env.destination.appId !== '*' && !dest.apps.includes(env.destination.appId)) return fail(404, 'UNKNOWN_APP', `${dest.nodeId} has no app ${env.destination.appId}`);
    if (dest.status === 'down') return fail(503, 'NODE_UNAVAILABLE', `${dest.nodeId} is down`, 'node_down');
    return this.deliver(dest, env, deadline, fair);
  }

  async broadcast(env, src, deadline, fair) {
    const appId = env.destination.appId;
    const all = env.scope === 'all';
    const targets = [...this.nodes.values()].filter(n => n.nodeId !== src.nodeId
      && (appId === '*' || n.apps.includes(appId)) && (all || !n.external));
    const results = await Promise.all(targets.map(n => (n.status === 'down'
      ? Promise.resolve(fail(503, 'NODE_UNAVAILABLE', `${n.nodeId} is down`, 'node_down'))
      : this.deliver(n, env, deadline, fair).catch(err => fail(503, 'NODE_UNAVAILABLE', `delivery to ${n.nodeId} failed: ${err && err.message}`, 'internal')))));
    const delivered = [], failed = [];
    results.forEach((r, i) => { if (r.ok) delivered.push(targets[i].nodeId); else failed.push({ nodeId: targets[i].nodeId, code: r.code }); });
    return { ok: true, status: 202, attempts: 1, failed, body: { accepted: true, messageId: env.messageId, delivered, failed } };
  }

  takeToken(node) {
    const b = node.bucket, c = this.config, now = Date.now();
    b.tokens = Math.min(c.rateLimitBurst, b.tokens + (now - b.last) * c.rateLimitPerSec / 1000);
    b.last = now;
    if (b.tokens >= 1) { b.tokens -= 1; return 0; }
    return Math.ceil((1 - b.tokens) * 1000 / c.rateLimitPerSec);
  }

  // Breaker gate, then up to retries+1 attempts inside the deadline.
  async deliver(node, env, deadline, fair = true) {
    const b = node.breaker;
    if (b.state === 'open') {
      if (Date.now() - b.openedAt < this.config.breakerOpenMs) return fail(503, 'NODE_UNAVAILABLE', `circuit open for ${node.nodeId}`, 'circuit_open');
      this.setBreaker(node, 'half-open');
    }
    if (b.state === 'half-open') {
      if (b.trial) return fail(503, 'NODE_UNAVAILABLE', `circuit half-open for ${node.nodeId}, trial in flight`, 'circuit_open');
      b.trial = true;
    }

    node.inFlight++;
    const t0 = Date.now();
    let result = null, attempts = 0;
    try {
      for (let attempt = 1; attempt <= this.config.retries + 1; attempt++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        attempts = attempt;
        result = await this.attempt(node, env, attempt, remaining);
        if (!result.retryable) break;
        const backoff = 100 * 2 ** (attempt - 1);
        if (attempt > this.config.retries || Date.now() + backoff >= deadline) break;
        this.metrics.retries++;
        await sleep(backoff);
      }
    } finally {
      node.inFlight--;
      b.trial = false;
    }
    if (!result) result = { ...fail(504, 'TIMEOUT', `no answer from ${node.nodeId} within ttl`), failure: true };
    if (result.code === 'TIMEOUT' && !fair) result.senderBudget = true;
    result.attempts = attempts;
    this.afterDelivery(node, result, Date.now() - t0);
    return result;
  }

  async attempt(node, env, attempt, timeoutMs) {
    let res, text;
    try {
      res = await fetch(this.url(node.deliverUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-nodelink-gateway': 'pisak', 'x-nodelink-attempt': String(attempt) },
        body: JSON.stringify(env),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
    } catch (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        return { ...fail(504, 'TIMEOUT', `no answer from ${node.nodeId} within ${timeoutMs} ms`), failure: true, retryable: false };
      }
      return { ...fail(503, 'NODE_UNAVAILABLE', `cannot reach ${node.nodeId}: ${err && err.message}`, 'unreachable'), failure: true, retryable: true };
    }
    // Never follow a redirect: it could send the gateway to another host or to the board's own API.
    if (res.status >= 300 && res.status < 400) {
      return { ...fail(503, 'NODE_UNAVAILABLE', `${node.nodeId} answered with a redirect (HTTP ${res.status}), not followed`, 'bad_response'),
        failure: true, retryable: false };
    }
    let body = null;
    if (text) { try { body = JSON.parse(text); } catch { body = null; } }

    if (res.status === 200 || res.status === 202) {
      if (env.type === 'request') {
        if (!body || body.type !== 'response') {
          return { ...fail(503, 'NODE_UNAVAILABLE', `${node.nodeId} answered without a response envelope`, 'bad_response'), failure: true, retryable: false };
        }
        return { ok: true, status: 200, body };
      }
      return { ok: true, status: 202, body: { accepted: true, messageId: env.messageId } };
    }

    // A node error with a protocol body is passed through to the sender.
    const code = body && body.error && typeof body.error === 'object' ? body.error.code : null;
    if (!PROTOCOL_CODES.has(code)) {
      return { ...fail(503, 'NODE_UNAVAILABLE', `${node.nodeId} answered HTTP ${res.status} without a NodeLink error`, 'bad_response'),
        failure: true, retryable: res.status >= 500 };
    }
    const failure = res.status >= 500;
    return { ok: false, status: res.status, code, body, failure, retryable: res.status === 503 || (failure && res.status !== 504) };
  }

  afterDelivery(node, r, ms) {
    if (this.nodes.get(node.nodeId) !== node) return; // deregistered or replaced meanwhile
    if (r.senderBudget) return; // the sender's short ttl, not the node's fault: no breaker count, no latency sample
    if (r.failure) {
      const b = node.breaker;
      b.failures++;
      if (b.state === 'half-open' || (b.state === 'closed' && b.failures >= this.config.breakerFailures)) this.setBreaker(node, 'open');
    } else {
      node.breaker.failures = 0;
      if (node.breaker.state !== 'closed') this.setBreaker(node, 'closed');
      this.markAlive(node);
    }
    if (r.ok || r.code === 'TIMEOUT') {
      node.recent.push(ms);
      if (node.recent.length > RECENT) node.recent.shift();
      const slow = percentile([...node.recent].sort((a, b) => a - b), 0.5) > this.config.slowThresholdMs;
      if (slow !== node.slow && node.status !== 'down') {
        node.slow = slow;
        this.events.emit(slow ? 'node-slow' : 'node-up', { from: 'gateway', to: node.nodeId, ok: !slow, nodeId: node.nodeId, latencyMs: ms });
      }
    }
  }

  setBreaker(node, state) {
    const b = node.breaker;
    b.state = state;
    if (state === 'open') b.openedAt = Date.now();
    if (state === 'closed') b.failures = 0;
    this.events.emit(`circuit-${state}`, { from: 'gateway', to: node.nodeId, ok: state === 'closed', nodeId: node.nodeId });
  }

  finish(env, out, latencyMs) {
    const code = out.ok ? null : (PROTOCOL_CODES.has(out.code) ? out.code : 'NODE_UNAVAILABLE');
    const bcastFail = out.failed && out.failed.length ? out.failed[0].code : null;
    this.metrics.record(latencyMs, code);
    this.events.emit('message', {
      from: env.source && env.source.nodeId, to: env.destination && env.destination.nodeId,
      ok: out.ok && !bcastFail, latencyMs, errorCode: code || bcastFail,
      messageId: env.messageId, type: env.type, appId: env.destination && env.destination.appId,
      attempts: out.attempts || 0, ...(out.failed ? { delivered: out.body.delivered.length, failedCount: out.failed.length, scope: env.scope || 'cluster' } : {}),
    });
  }

  // ---------- failure detection (called by the plugin's timer) ----------

  tick() {
    if (this.status !== 'up') return;
    const now = Date.now(), c = this.config;
    for (const node of this.nodes.values()) {
      const excused = node.leaving || node.graceUntil > now; // planned: farzad does not count these
      if (node.status !== 'down' && !excused && now - node.lastSeen > c.probeTimeoutMs) {
        node.status = 'down';
        node.slow = false;
        const detectMs = now - node.lastSeen;
        this.metrics.detected(detectMs);
        this.events.emit('node-down', { from: 'gateway', to: node.nodeId, ok: false, errorCode: 'NODE_UNAVAILABLE', nodeId: node.nodeId, detectMs });
      }
      if (node.heartbeatUrl && !node.probing && now - node.lastProbeAt >= c.probeIntervalMs) this.probe(node);
    }
  }

  probe(node) {
    node.probing = true;
    node.lastProbeAt = Date.now();
    const timeout = Math.max(100, Math.min(this.config.probeIntervalMs, this.config.probeTimeoutMs));
    fetch(this.url(node.heartbeatUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-nodelink-gateway': 'pisak' },
      body: JSON.stringify({ from: 'gateway', seq: ++node.probeSeq, ts: Date.now(), state: 'up', peers: this.peersOf(node) }),
      redirect: 'manual', // a 3xx is not res.ok, so it counts as a failed probe
      signal: AbortSignal.timeout(timeout),
    })
      .then(async res => {
        const text = await res.text();
        if (res.ok && this.status === 'up' && this.nodes.get(node.nodeId) === node) {
          let answer = null;
          try { answer = JSON.parse(text); } catch { answer = null; }
          node.probeFailures = 0;
          this.markAlive(node);
          if (answer && typeof answer === 'object') this.applyState(node, answer.state);
        } else node.probeFailures++;
      })
      .catch(() => { node.probeFailures++; }) // a silent or killed node is the expected failure here; tick() reports it
      .finally(() => { node.probing = false; });
  }

  // ---------- control ----------

  admin(body) {
    const action = body && body.action;
    if (action === 'kill') {
      this.status = 'down';
      this.killedAt = Date.now();
      this.nodes.clear();
      this.events.emit('gateway-killed', { from: 'control', to: 'gateway', ok: false, gatewayId: this.id });
    } else if (action === 'revive') {
      if (this.status !== 'up') {
        this.status = 'up';
        this.startedAt = Date.now();
        this.events.emit('gateway-revived', { from: 'control', to: 'gateway', ok: true, gatewayId: this.id });
      }
    } else if (action === 'config') {
      const patch = body.config;
      if (!patch || typeof patch !== 'object') return badRequest('config must be an object');
      const changed = {};
      for (const [k, v] of Object.entries(patch)) {
        if (!(k in LIMITS)) return badRequest(`unknown config key ${k}`);
        const [lo, hi] = LIMITS[k];
        if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) return badRequest(`${k} must be a number in [${lo}, ${hi}]`);
        changed[k] = v;
      }
      Object.assign(this.config, changed);
      this.events.emit('config-changed', { from: 'control', to: 'gateway', ok: true, config: changed });
    } else if (action === 'reset') {
      // Not a revive: farzad calls reset before every gateway switch, and a killed gateway must still fail it.
      this.nodes.clear();
      this.metrics.reset();
      this.events.reset();
      if (this.status === 'up') this.startedAt = Date.now();
    } else {
      return badRequest('action must be kill, revive, config or reset');
    }
    return { status: 200, body: { ok: true, state: this.state() } };
  }

  state() {
    const nodes = [...this.nodes.values()];
    const linkState = { up: 'reachable', slow: 'reachable', down: 'unreachable', restarting: 'restarting', leaving: 'disabled' };
    const links = nodes.map(n => {
      const status = this.nodeStatus(n);
      return { from: n.nodeId, to: 'gateway', status, state: this.status === 'up' ? linkState[status] : 'unreachable' };
    });
    return {
      gateway: { id: this.id, status: this.status, startedAt: this.startedAt },
      config: { ...this.config },
      maxMessageBytes: MAX_MESSAGE_BYTES,
      routes: this.routes,
      nodes: nodes.map(n => ({
        nodeId: n.nodeId, apps: n.apps, external: n.external, status: this.nodeStatus(n), circuit: n.breaker.state,
        lastSeen: n.lastSeen, p50Ms: percentile([...n.recent].sort((a, b) => a - b), 0.5), inFlight: n.inFlight,
      })),
      links,
      possibleLinks: links.length,
      openConnections: links.filter(l => l.state === 'reachable').length,
      connections: nodes.filter(n => n.status !== 'down').length,
      metrics: this.metrics.summary(),
    };
  }
}

function validateEnvelope(env) {
  if (!env) return 'body must be a JSON envelope';
  if (env.proto !== undefined && env.proto !== 'nodelink') return 'proto must be "nodelink"';
  if (env.version !== undefined && env.version !== 2) return 'unsupported version, this gateway speaks version 2';
  if (typeof env.messageId !== 'string' || !env.messageId || env.messageId.length > 128) return 'messageId must be a non-empty string';
  if (!TYPES.has(env.type)) return 'type must be request, response, oneway or broadcast';
  for (const side of ['source', 'destination']) {
    const v = env[side];
    if (!v || typeof v !== 'object' || typeof v.nodeId !== 'string' || typeof v.appId !== 'string') return `${side} must be {nodeId, appId}`;
    if (v.listenerId !== undefined && v.listenerId !== null && typeof v.listenerId !== 'string') return `${side}.listenerId must be a string or null`;
  }
  if (env.type === 'broadcast' && env.destination.nodeId !== '*') return 'broadcast needs destination.nodeId "*"';
  if (env.type !== 'broadcast' && env.destination.nodeId === '*') return 'destination.nodeId "*" is only for broadcast';
  if (env.type === 'broadcast' && env.destination.listenerId) return 'a broadcast cannot address a listenerId';
  if (env.scope !== undefined && env.scope !== null && env.scope !== 'cluster' && env.scope !== 'all') return 'scope must be cluster or all';
  if (env.ttlMs !== undefined && env.ttlMs !== null && (typeof env.ttlMs !== 'number' || !(env.ttlMs > 0))) return 'ttlMs must be a positive number';
  return null;
}

module.exports = { Gateway, DEFAULTS, validateEnvelope };
