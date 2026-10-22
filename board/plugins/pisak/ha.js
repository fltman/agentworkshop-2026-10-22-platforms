'use strict';
// Gateway HA pair (contract: projects/pisak/CONTRACT.md section 9). Two instances, a and b, behind one base URL, like
// a virtual IP. The active one serves every call and replicates its registry (node identities and tokens) to the
// standby every tick. When the active is killed, the standby takes over after `detectMs`; nodes keep their tokens.
// With HA off (the default) only the active instance runs, and kill, revive and reset behave as without HA.

const { Gateway } = require('./gateway');
const { Events, Metrics } = require('./telemetry');

const DETECT_LIMITS = [100, 10000];

const badRequest = msg => ({ status: 400, body: { error: { code: 'BAD_PROTOCOL', reason: null, at: 'gateway', message: msg }, correlationId: null } });

class GatewayPair {
  constructor() {
    const shared = { events: new Events(), metrics: new Metrics() };
    this.a = new Gateway('a', shared);
    this.b = new Gateway('b', shared);
    this.b.status = 'down'; // not running until HA is enabled
    this.active = this.a;
    this.enabled = false;
    this.detectMs = 1000;
    this.failovers = 0;
    this.lastFailoverMs = null;
    this.lastFailoverAt = null;
  }

  get events() { return this.active.events; }
  get metrics() { return this.active.metrics; }
  get id() { return this.active.id; }
  get status() { return this.active.status; }
  get baseUrl() { return this.a.baseUrl; }
  set baseUrl(v) { this.a.baseUrl = v; this.b.baseUrl = v; }

  standby() { return this.active === this.a ? this.b : this.a; }
  instance(id) { return id === 'a' ? this.a : id === 'b' ? this.b : null; }

  register(body) { return this.active.register(body); }
  heartbeat(req, body) { return this.active.heartbeat(req, body); }
  deregister(req, body) { return this.active.deregister(req, body); }
  listNodes(req) { return this.active.listNodes(req); }
  route(req, body) { return this.active.route(req, body); }

  tick() {
    const act = this.active, sb = this.standby();
    act.tick();
    if (!this.enabled || sb.status !== 'up') return;
    if (act.status === 'up') sb.restore(act.snapshot());
    else if (Date.now() - act.killedAt >= this.detectMs) this.promote(sb, act);
  }

  promote(next, prev) {
    const now = Date.now();
    for (const n of next.nodes.values()) { n.lastSeen = now; n.lastProbeAt = 0; }
    this.active = next;
    this.failovers++;
    this.lastFailoverMs = now - prev.killedAt;
    this.lastFailoverAt = now;
    next.events.emit('gateway-failover', { from: prev.id, to: next.id, ok: true, gatewayId: next.id,
      failoverMs: this.lastFailoverMs, nodes: next.nodes.size });
  }

  admin(body) {
    const action = body && body.action;
    if (action === 'ha') return this.setHa(body);
    if (action === 'kill' || action === 'revive') {
      const which = body.instance;
      if (which !== undefined && which !== null && !this.instance(which)) return badRequest('instance must be a or b');
      const target = which ? this.instance(which) : null;
      if (target && target !== this.active && !this.enabled) return badRequest(`instance ${which} is not running, enable ha first`);
      if (action === 'kill') {
        (target || this.active).admin({ action: 'kill' });
      } else {
        for (const g of target ? [target] : (this.enabled ? [this.active, this.standby()] : [this.active])) this.revive(g);
      }
    } else if (action === 'config') {
      const out = this.a.admin(body);
      if (out.status !== 200) return out;
      this.b.config = { ...this.a.config };
    } else if (action === 'reset') {
      // Not a revive, and HA settings and failover counters stay: like the routes counter, they span resets.
      this.a.admin({ action: 'reset' });
      this.b.nodes.clear();
    } else {
      return badRequest('action must be kill, revive, config, reset or ha');
    }
    return { status: 200, body: { ok: true, state: this.state() } };
  }

  // A revived instance resyncs from its running peer, so a revived active does not come back empty.
  revive(g) {
    if (g.status === 'up') return;
    g.admin({ action: 'revive' });
    const peer = g === this.a ? this.b : this.a;
    if (this.enabled && peer.status === 'up') g.restore(peer.snapshot());
  }

  setHa(body) {
    if (typeof body.enabled !== 'boolean') return badRequest('enabled must be true or false');
    if (body.detectMs !== undefined) {
      const [lo, hi] = DETECT_LIMITS;
      if (typeof body.detectMs !== 'number' || !Number.isFinite(body.detectMs) || body.detectMs < lo || body.detectMs > hi) {
        return badRequest(`detectMs must be a number in [${lo}, ${hi}]`);
      }
      this.detectMs = body.detectMs;
    }
    const sb = this.standby();
    if (body.enabled && !this.enabled) {
      this.enabled = true;
      sb.status = 'up';
      sb.startedAt = Date.now();
      sb.config = { ...this.active.config };
      sb.restore(this.active.status === 'up' ? this.active.snapshot() : []);
      // Enabling HA while the gateway is dead starts the standby as the new active (empty registry: nodes re-register).
      if (this.active.status !== 'up') this.active = sb;
      sb.events.emit('ha-enabled', { from: 'control', to: 'gateway', ok: true, gatewayId: this.active.id, detectMs: this.detectMs });
    } else if (!body.enabled && this.enabled) {
      this.enabled = false;
      if (this.active.status !== 'up' && sb.status === 'up') this.active = sb;
      const off = this.standby();
      off.status = 'down';
      off.nodes.clear();
      this.active.events.emit('ha-disabled', { from: 'control', to: 'gateway', ok: true, gatewayId: this.active.id });
    }
    return { status: 200, body: { ok: true, state: this.state() } };
  }

  state() {
    const s = this.active.state();
    s.routes = this.a.routes + this.b.routes;
    s.ha = {
      enabled: this.enabled, active: this.active.id, detectMs: this.detectMs,
      failovers: this.failovers, lastFailoverMs: this.lastFailoverMs, lastFailoverAt: this.lastFailoverAt,
      instances: [this.a, this.b].map(g => ({
        id: g.id, status: g.status, role: g === this.active ? 'active' : (this.enabled ? 'standby' : 'off'), nodes: g.nodes.size,
      })),
    };
    return s;
  }
}

module.exports = { GatewayPair };
