const fs = require('node:fs');
const path = require('node:path');

const defaultState = () => ({
  mode: 'mesh',
  nodeCount: 5,
  running: true,
  traffic: {
    rate: 120,
    payloadBytes: 256,
    dropRate: 0,
    mix: { request: 60, response: 20, oneWay: 13, broadcast: 7 },
  },
  chaos: {
    nodeKilled: null,
    slowNode: null,
    slowNodeMs: 0,
    dropRate: 0,
  },
  gateway: {
    healthy: true,
    haEnabled: false,
    timeoutMs: 1200,
    retries: 3,
    rateLimitPerSec: 300,
    circuitOpen: false,
  },
  metrics: {
    throughput: 118,
    latencyP50: 22,
    latencyP95: 49,
    errorRate: 0.02,
    openConnections: 10,
    failedNodeDetectionMs: 1500,
  },
  scenario: {
    name: 'baseline',
    step: 'ready',
  },
  events: [],
  updatedAt: new Date().toISOString(),
});

function stateFile(dataDir) {
  return path.join(dataDir, 'platforms-tp.state.json');
}

function eventsFile(dataDir) {
  return path.join(dataDir, 'platforms-tp.events.json');
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function readJson(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed;
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function pruneEvents(list) {
  return (list || []).slice(-20);
}

function readState(dataDir) {
  const saved = readJson(stateFile(dataDir), null);
  if (!saved) return defaultState();

  return {
    ...defaultState(),
    ...saved,
    traffic: { ...defaultState().traffic, ...(saved.traffic || {}) },
    chaos: { ...defaultState().chaos, ...(saved.chaos || {}) },
    gateway: { ...defaultState().gateway, ...(saved.gateway || {}) },
    metrics: { ...defaultState().metrics, ...(saved.metrics || {}) },
    scenario: { ...defaultState().scenario, ...(saved.scenario || {}) },
    events: pruneEvents(saved.events),
    updatedAt: new Date().toISOString(),
  };
}

function writeState(dataDir, state) {
  const target = stateFile(dataDir);
  writeJson(target, state);
}

function readEvents(dataDir) {
  return readJson(eventsFile(dataDir), []);
}

function writeEvents(dataDir, events) {
  const target = eventsFile(dataDir);
  writeJson(target, pruneEvents(events));
}

function recordEvent(state, dataDir, type, text) {
  const entry = { type, text, ts: Date.now() };
  const nextEvents = pruneEvents([...(state.events || []), entry]);
  state.events = nextEvents;
  writeEvents(dataDir, nextEvents);
}

class GatewayAdminError extends Error {
  constructor(message, status = 502, state = null) {
    super(message);
    this.status = status;
    this.state = state;
  }
}

async function gatewayAdmin(action) {
  const port = Number(process.env.PORT || 8180);
  const url = new URL('/t/pisak/api/admin', `http://127.0.0.1:${port}`);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
      redirect: 'manual',
      signal: AbortSignal.timeout(3000),
    });
  } catch (err) {
    throw new GatewayAdminError(`Gateway admin request failed: ${err.message}`);
  }

  if (response.status >= 300 && response.status < 400) {
    throw new GatewayAdminError(`Gateway admin returned an unexpected redirect (HTTP ${response.status}).`);
  }

  let result;
  try {
    result = await response.json();
  } catch {
    throw new GatewayAdminError(`Gateway admin returned invalid JSON (HTTP ${response.status}).`);
  }

  if (!response.ok || result?.ok !== true) {
    throw new GatewayAdminError(result?.error?.message || `Gateway admin returned HTTP ${response.status}.`);
  }

  return result.state || null;
}

function syncGatewayHealth(state, gatewayState) {
  const status = gatewayState?.gateway?.status ?? gatewayState?.status;
  if (status === 'down') state.gateway.healthy = false;
  else if (status === 'up') state.gateway.healthy = true;
}

function simulateMetrics(state) {
  const baseRate = Number(state.traffic.rate || 0);
  const dropRatio = clamp(Number(state.chaos.dropRate ?? state.traffic.dropRate ?? 0), 0, 100) / 100;
  const gatewayPenalty = state.gateway.healthy === false ? 0.45 : 1;
  const modePenalty = state.mode === 'gateway' ? 0.9 : 1.15;
  const nodePenalty = state.chaos.nodeKilled === null ? 1 : 0.72;
  const throughput = Math.max(0, Math.round(baseRate * (1 - dropRatio) * gatewayPenalty * modePenalty * nodePenalty));
  const slowBase = state.chaos.slowNode !== null ? Number(state.chaos.slowNodeMs || 1500) : 220;
  const latencyP50 = clamp(Math.round((slowBase * 0.55) + state.traffic.payloadBytes * 0.03), 18, 2500);
  const latencyP95 = clamp(Math.round((slowBase * 0.85) + state.traffic.payloadBytes * 0.06), 40, 6000);
  const openConnections = state.mode === 'mesh'
    ? Math.max(0, (state.nodeCount * (state.nodeCount - 1)) / 2)
    : Math.max(0, state.nodeCount + 2 + (state.gateway.haEnabled ? 1 : 0));
  const errorRate = Number((dropRatio * 0.42 + (state.gateway.healthy ? 0 : 0.12)).toFixed(3));
  state.metrics = {
    throughput,
    latencyP50,
    latencyP95,
    errorRate,
    openConnections,
    failedNodeDetectionMs: state.chaos.nodeKilled === null ? 1200 : 1200 + (state.nodeCount * 120),
  };
}

async function applyAction(state, dataDir, action, payload={}) {
  switch (action) {
    case 'toggle-mode': {
      if (state.mode === 'mesh') {
        const gatewayState = await gatewayAdmin('reset');
        syncGatewayHealth(state, gatewayState);
        if (!state.gateway.healthy) {
          state.scenario.step = 'gateway down';
          recordEvent(state, dataDir, 'gateway', 'Gateway remains down after reset; gateway mode was not started');
          simulateMetrics(state);
          state.updatedAt = new Date().toISOString();
          throw new GatewayAdminError('Gateway is down; cannot switch to gateway mode.', 503, state);
        }
      }
      state.mode = state.mode === 'mesh' ? 'gateway' : 'mesh';
      state.scenario.step = state.mode === 'mesh' ? 'mesh active' : 'gateway active';
      recordEvent(state, dataDir, 'mode', `Mode switched to ${state.mode}`);
      break;
    }
    case 'set-traffic': {
      const rate = clamp(Number(payload.rate ?? state.traffic.rate), 10, 500);
      const payloadBytes = clamp(Number(payload.payloadBytes ?? state.traffic.payloadBytes), 64, 4096);
      const dropRate = clamp(Number(payload.dropRate ?? state.chaos.dropRate ?? state.traffic.dropRate ?? 0), 0, 100);
      state.traffic.rate = rate;
      state.traffic.payloadBytes = payloadBytes;
      state.chaos.dropRate = dropRate;
      state.scenario.step = 'traffic tuned';
      recordEvent(state, dataDir, 'traffic', `Traffic set to ${rate} msg/s, payload ${payloadBytes} bytes, drop ${dropRate}%`);
      break;
    }
    case 'start-scenario': {
      state.running = true;
      state.scenario.name = payload.name || 'live-demo';
      state.scenario.step = 'running';
      recordEvent(state, dataDir, 'scenario', `Scenario started: ${state.scenario.name}`);
      break;
    }
    case 'kill-node': {
      const nodeId = Number(payload.nodeId ?? state.chaos.nodeKilled ?? 2);
      state.chaos.nodeKilled = Number.isFinite(nodeId) ? nodeId : null;
      state.scenario.step = state.chaos.nodeKilled !== null ? 'node failed' : 'ready';
      recordEvent(state, dataDir, 'fault', state.chaos.nodeKilled !== null ? `Node ${state.chaos.nodeKilled} failed` : 'Node failure cleared');
      break;
    }
    case 'slow-node': {
      const nodeId = Number(payload.nodeId ?? 3);
      const latencyMs = clamp(Number(payload.latencyMs ?? 3000), 500, 10000);
      state.chaos.slowNode = Number.isFinite(nodeId) ? nodeId : null;
      state.chaos.slowNodeMs = latencyMs;
      state.scenario.step = state.chaos.slowNode !== null ? 'node slowed' : 'ready';
      recordEvent(state, dataDir, 'fault', state.chaos.slowNode !== null ? `Node ${state.chaos.slowNode} slowed to ${latencyMs} ms` : 'Slow-node fault cleared');
      break;
    }
    case 'drop-messages': {
      const dropRate = clamp(Number(payload.dropRate ?? state.chaos.dropRate ?? 0), 0, 100);
      state.chaos.dropRate = dropRate;
      state.scenario.step = dropRate > 0 ? 'message loss injected' : 'steady';
      recordEvent(state, dataDir, 'fault', `Drop rate set to ${dropRate}%`);
      break;
    }
    case 'toggle-gateway': {
      const action = state.gateway.healthy ? 'kill' : 'revive';
      const gatewayState = await gatewayAdmin(action);
      syncGatewayHealth(state, gatewayState);
      const status = gatewayState?.gateway?.status ?? gatewayState?.status;
      if (status !== 'up' && status !== 'down') {
        state.gateway.healthy = action === 'revive';
      }
      state.scenario.step = state.gateway.healthy ? 'gateway healthy' : 'gateway down';
      recordEvent(state, dataDir, 'gateway', `Gateway ${state.gateway.healthy ? 'recovered' : 'killed'}`);
      break;
    }
    case 'toggle-ha': {
      state.gateway.haEnabled = !state.gateway.haEnabled;
      state.scenario.step = state.gateway.haEnabled ? 'ha active' : 'ha standby';
      recordEvent(state, dataDir, 'gateway', `HA pair ${state.gateway.haEnabled ? 'enabled' : 'disabled'}`);
      break;
    }
    case 'reset': {
      const previousHealth = state.gateway.healthy;
      const gatewayState = await gatewayAdmin('reset');
      const status = gatewayState?.gateway?.status ?? gatewayState?.status;
      const fresh = defaultState();
      fresh.gateway.healthy = status === 'down'
        ? false
        : status === 'up'
          ? true
          : previousHealth;
      Object.assign(state, fresh);
      recordEvent(state, dataDir, 'scenario', 'System reset to baseline');
      break;
    }
    default:
      throw new Error(`Unsupported action: ${action}`);
  }

  simulateMetrics(state);
  state.updatedAt = new Date().toISOString();
  return state;
}

function summaryText(state) {
  return `${state.mode.toUpperCase()} mode • ${state.nodeCount} nodes • ${state.metrics.throughput} msg/s • ${state.metrics.latencyP95} ms p95`;
}

module.exports = {
  init(ctx) {
    fs.mkdirSync(ctx.dataDir, { recursive: true });
    const fresh = readState(ctx.dataDir);
    if (!fresh.events || !fresh.events.length) {
      fresh.events = [{ type: 'system', text: 'Control module initialized', ts: Date.now() }];
    }
    writeState(ctx.dataDir, fresh);
    writeEvents(ctx.dataDir, fresh.events);
  },

  async handle(req, res, { path, dataDir, team }) {
    const state = readState(dataDir);

    if (req.method === 'GET' && path === '/status') {
      const summary = summaryText(state);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        team,
        summary,
        mode: state.mode,
        nodeCount: state.nodeCount,
        throughput: state.metrics.throughput,
        latencyP95: state.metrics.latencyP95,
        errorRate: state.metrics.errorRate,
        openConnections: state.metrics.openConnections,
        events: state.events,
      }));
      return true;
    }

    if (req.method === 'GET' && path === '/api/state') {
      const nextState = readState(dataDir);
      simulateMetrics(nextState);
      writeState(dataDir, nextState);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(nextState));
      return true;
    }

    if (req.method === 'GET' && path === '/api/events') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(readEvents(dataDir)));
      return true;
    }

    if (req.method === 'POST' && path === '/api/control') {
      let payload = {};
      const raw = await new Promise((resolve) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => resolve(body));
      });

      if (raw) {
        try {
          payload = JSON.parse(raw);
        } catch {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Invalid JSON body.' }));
          return true;
        }
      }

      const action = payload.action;
      if (!action || typeof action !== 'string') {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Missing action.' }));
        return true;
      }

      try {
        const nextState = await applyAction(readState(dataDir), dataDir, action, payload);
        writeState(dataDir, nextState);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, state: nextState }));
        return true;
      } catch (err) {
        if (err.state) writeState(dataDir, err.state);
        res.writeHead(err.status || 400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message || 'Bad request', ...(err.state ? { state: err.state } : {}) }));
        return true;
      }
    }

    return false;
  },

  onMessage(m, { board, team, dataDir }) {
    if (m.from === team) return;
    if (!new RegExp(`@${team}\\b`, 'i').test(m.text)) return;
    const state = readState(dataDir);
    board.post(`Control is ${state.mode} mode with ${state.nodeCount} nodes, ${state.metrics.throughput} msg/s and ${state.metrics.latencyP95} ms p95.`, m.channel, m.id);
  },
};
