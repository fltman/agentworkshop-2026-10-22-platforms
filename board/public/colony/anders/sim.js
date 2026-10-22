// Demo simulator. Used only while the Node module (farzad) is unreachable, so the dashboard can be shown and
// tested. It answers with the same shapes as farzad's and pisak's v0.2 contracts. The UI marks it as DEMO DATA.
function createSim() {
  const WINDOW_MS = 10000;
  let seq = 0, drained = 0, nextId = 1, mode = 'mesh', gwUp = true;
  let nodes = [], events = [], samples = [];
  let traffic = { rate: 0, mix: { request: 0.6, oneway: 0.3, broadcast: 0.1 } };
  let detect = { mesh: null, gateway: null };
  const now = () => Date.now();
  const rnd = (a, b) => a + Math.random() * (b - a);
  const push = e => {
    seq++;
    events.push({ id: 'sim-' + seq, seq, ts: now(), from: null, to: null, ok: true, latencyMs: null, errorCode: null, mode, ...e });
    if (events.length > 2000) events.splice(0, events.length - 2000);
  };
  const mk = () => ({ nodeId: 'n' + nextId++, external: false, status: 'up', messaging: 'enabled', inflight: 0,
    apps: [{ appId: 'echo' }, { appId: 'sink' }], chaos: { delayMs: 0, dropPercent: 0, skewMs: 0 },
    killedAt: null, detected: false, detectDelay: 0 });
  const find = id => {
    const n = nodes.find(x => x.nodeId === id);
    if (!n) throw new Error('UNKNOWN_NODE ' + id);
    return n;
  };
  const reachable = n => n.status === 'up' || !n.detected;

  function reset(count, m) {
    nextId = 1; nodes = Array.from({ length: count }, mk); mode = m || 'mesh';
    samples = []; detect = { mesh: null, gateway: null };
    push({ type: 'mode.change', ok: true });
  }
  reset(5, 'mesh');

  function metrics(m) {
    const t = now(), s = samples.filter(x => x.mode === m && t - x.ts < WINDOW_MS);
    const lat = s.filter(x => x.ok).map(x => x.lat).sort((a, b) => a - b);
    const pct = p => lat.length ? Math.round(lat[Math.min(lat.length - 1, Math.floor(p * lat.length))]) : 0;
    return { p50Ms: pct(0.5), p95Ms: pct(0.95), throughputPerSec: +(s.length / (WINDOW_MS / 1000)).toFixed(1),
      errorRate: s.length ? +(s.filter(x => !x.ok).length / s.length).toFixed(3) : 0, detectMs: detect[m] };
  }

  function sendOne(t) {
    const senders = nodes.filter(n => n.status === 'up');
    if (!senders.length) return;
    const from = senders[Math.floor(Math.random() * senders.length)];
    const r = Math.random();
    const type = r < traffic.mix.request ? 'request' : r < traffic.mix.request + traffic.mix.oneway ? 'oneway' : 'broadcast';
    const others = nodes.filter(n => n !== from);
    const to = type === 'broadcast' ? null : others[Math.floor(Math.random() * others.length)];
    let lat = mode === 'mesh' ? rnd(2, 6) : rnd(4, 10);
    let ok = true, errorCode = null;
    if (mode === 'gateway' && !gwUp) { ok = false; errorCode = 'NODE_UNAVAILABLE'; lat = rnd(1, 3); }
    else if (to && to.status !== 'up') {
      ok = false;
      if (to.detected) { errorCode = 'NODE_UNAVAILABLE'; lat = rnd(1, 3); } else { errorCode = 'TIMEOUT'; lat = 2000; }
    } else if (to && Math.random() * 100 < to.chaos.dropPercent) { ok = false; errorCode = 'TIMEOUT'; lat = 2000; }
    else if (to) lat += to.chaos.delayMs;
    samples.push({ ts: t, mode, lat, ok });
    push({ type: 'message.' + type, from: from.nodeId, to: to ? to.nodeId : '*', ok, errorCode,
      latencyMs: Math.round(lat), messageId: from.nodeId + '-' + seq });
  }

  function tick() {
    const t = now();
    for (const n of nodes) {
      if (n.status !== 'down' || n.detected) continue;
      if (mode === 'gateway' && !gwUp) continue;
      if (t - n.killedAt >= n.detectDelay) {
        n.detected = true;
        detect[mode] = t - n.killedAt;
        const peer = nodes.find(x => x.status === 'up');
        push({ type: 'node.down', from: mode === 'mesh' ? (peer ? peer.nodeId : null) : 'gateway', to: n.nodeId,
          ok: false, errorCode: 'NODE_UNAVAILABLE', detectMs: detect[mode] });
      }
    }
    const count = Math.floor(traffic.rate / 10 + Math.random());
    for (let i = 0; i < count; i++) sendOne(t);
    samples = samples.filter(x => t - x.ts < WINDOW_MS);
  }
  setInterval(tick, 100);

  return {
    state() {
      const links = [];
      if (mode === 'mesh') {
        for (const a of nodes) for (const b of nodes) if (a !== b)
          links.push({ from: a.nodeId, to: b.nodeId, state: a.status === 'up' && reachable(b) ? 'reachable' : 'unreachable' });
      } else {
        for (const n of nodes) links.push({ from: n.nodeId, to: 'gateway', state: gwUp && reachable(n) ? 'reachable' : 'unreachable' });
      }
      const n = nodes.length;
      return { mode, switching: false, nodes: nodes.map(({ killedAt, detected, detectDelay, ...x }) => x), links,
        possibleLinks: mode === 'mesh' ? n * (n - 1) : n,
        openConnections: links.filter(l => l.state === 'reachable').length,
        metrics: { mesh: metrics('mesh'), gateway: metrics('gateway') } };
    },
    gwState() {
      return { gateway: { id: 'a', status: gwUp ? 'up' : 'down' },
        nodes: mode !== 'gateway' ? [] : nodes.map(n => ({ nodeId: n.nodeId,
          status: n.status !== 'up' && n.detected ? 'down' : n.chaos.delayMs > 0 ? 'slow' : 'up',
          circuit: n.status !== 'up' && n.detected ? 'open' : 'closed' })),
        metrics: metrics('gateway') };
    },
    drain() {
      const out = events.filter(e => e.seq > drained);
      drained = seq;
      return out;
    },
    handle(target, method, path, body = {}) {
      if (target === 'pisak' && path === '/admin') {
        if (body.action === 'kill') { gwUp = false; push({ type: 'gateway.killed', from: 'gateway', ok: false }); }
        else if (body.action === 'revive') { gwUp = true; push({ type: 'gateway.revived', from: 'gateway' }); }
        return { ok: true };
      }
      if (path === '/reset') { reset(Math.max(3, Math.min(20, body.nodes || 5)), body.mode); return { ok: true }; }
      if (path === '/nodes' && method === 'POST') {
        if (nodes.length >= 20) throw new Error('MAX_NODES at most 20 nodes');
        const added = Array.from({ length: body.count || 1 }, mk);
        nodes.push(...added);
        added.forEach(n => push({ type: 'node.up', to: n.nodeId }));
        return { nodeIds: added.map(n => n.nodeId) };
      }
      if (path.startsWith('/nodes/') && method === 'DELETE') {
        if (nodes.length <= 3) throw new Error('MIN_NODES at least 3 nodes');
        const n = find(path.split('/')[2]);
        nodes = nodes.filter(x => x !== n);
        push({ type: 'node.leaving', to: n.nodeId, ok: true });
        return { ok: true };
      }
      if (path === '/mode') {
        if (body.mode === 'gateway' && !gwUp) throw new Error('MODE_SWITCH_FAILED gateway is down');
        mode = body.mode;
        push({ type: 'mode.change', ok: true });
        return { mode, switchMs: 0, failed: [] };
      }
      if (path === '/traffic') {
        traffic = { rate: body.rate || 0, mix: body.mix || traffic.mix };
        return { ok: true };
      }
      if (path === '/chaos') {
        const n = find(body.nodeId);
        if (body.action === 'kill') {
          n.status = 'down'; n.killedAt = now(); n.detected = false;
          n.detectDelay = mode === 'mesh' ? rnd(3000, 3400) : rnd(3000, 3100);
        } else if (body.action === 'revive') { n.status = 'up'; n.killedAt = null; n.detected = false; push({ type: 'node.up', to: n.nodeId }); }
        else if (body.action === 'slow') n.chaos.delayMs = body.delayMs || 800;
        else if (body.action === 'drop') n.chaos.dropPercent = body.percent || 30;
        else if (body.action === 'clear') n.chaos = { delayMs: 0, dropPercent: 0, skewMs: 0 };
        push({ type: 'chaos', to: n.nodeId, ok: true, action: body.action });
        return { ok: true };
      }
      throw new Error('unsupported in demo: ' + method + ' ' + path);
    },
  };
}
