const fs = require('node:fs');
const path = require('node:path');

const NODE_API = Object.freeze({
  state: '/t/farzad/api/state',
  events: '/t/farzad/api/events',
  reset: '/t/farzad/api/reset',
  nodes: '/t/farzad/api/nodes',
  mode: '/t/farzad/api/mode',
  traffic: '/t/farzad/api/traffic',
  chaos: '/t/farzad/api/chaos',
});
const GATEWAY_API = Object.freeze({
  state: '/t/pisak/api/state',
  metrics: '/t/pisak/api/metrics',
  admin: '/t/pisak/api/admin',
});
const LOOPBACK_PATHS = new Set([...Object.values(NODE_API), ...Object.values(GATEWAY_API)]);

const defaultState = () => ({
  mode: 'mesh',
  source: 'simulation',
  nodeCount: 5,
  running: false,
  traffic: {
    rate: 120,
    payloadBytes: 256,
    dropRate: 0,
    mix: { request: 60, oneway: 33, broadcast: 7 },
  },
  chaos: {
    nodeKilled: null,
    slowNode: null,
    slowNodeMs: 0,
    dropRate: 0,
    dropNodeId: null,
  },
  gateway: {
    healthy: true,
    available: false,
    haEnabled: false,
    timeoutMs: 1200,
    retries: 3,
    rateLimitPerSec: 300,
    circuitOpen: false,
    ha: null,
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
    runId: null,
    results: { mesh: null, gateway: null },
    baseline: null,
    detection: { mesh: null, gateway: null },
    eventCursors: {},
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
    scenario: {
      ...defaultState().scenario,
      ...(saved.scenario || {}),
      results: { ...defaultState().scenario.results, ...(saved.scenario?.results || {}) },
      detection: { ...defaultState().scenario.detection, ...(saved.scenario?.detection || {}) },
      eventCursors: { ...(saved.scenario?.eventCursors || {}) },
    },
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

async function loopbackApi(pathname, method = 'GET', body, query = {}) {
  if (!LOOPBACK_PATHS.has(pathname)) {
    throw new GatewayAdminError('Unsupported upstream API path.');
  }

  const port = Number(process.env.PORT || 8180);
  const url = new URL(pathname, `http://127.0.0.1:${port}`);
  if (url.pathname !== pathname) {
    throw new GatewayAdminError('Upstream API path was not preserved.');
  }
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(3000),
    });
  } catch (err) {
    throw new GatewayAdminError(`Upstream API request failed: ${err.message}`);
  }

  if (response.status >= 300 && response.status < 400) {
    throw new GatewayAdminError(`Upstream API returned an unexpected redirect (HTTP ${response.status}).`);
  }

  if (response.status >= 300 && response.status < 400) {
    throw new GatewayAdminError(`Gateway admin returned an unexpected redirect (HTTP ${response.status}).`);
  }

  let result;
  try {
    result = await response.json();
  } catch {
    throw new GatewayAdminError(`Upstream API returned invalid JSON (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    throw new GatewayAdminError(result?.error?.message || `Upstream API returned HTTP ${response.status}.`);
  }

  return result;
}

async function gatewayAdmin(action, options = {}) {
  const result = await loopbackApi(GATEWAY_API.admin, 'POST', { action, ...options });
  if (result?.ok !== true) {
    throw new GatewayAdminError(result?.error?.message || 'Gateway admin rejected the action.');
  }
  return result.state || null;
}

function syncGatewayHealth(state, gatewayState) {
  const status = gatewayState?.gateway?.status ?? gatewayState?.status;
  state.gateway.available = true;
  if (status === 'down') state.gateway.healthy = false;
  else if (status === 'up') state.gateway.healthy = true;
  if (gatewayState?.ha && typeof gatewayState.ha.enabled === 'boolean') {
    state.gateway.ha = gatewayState.ha;
    state.gateway.haEnabled = gatewayState.ha.enabled;
  }
}

function syncNodeState(state, nodeState) {
  const mode = nodeState?.mode;
  const metrics = nodeState?.metrics?.[mode];
  if (mode !== 'mesh' && mode !== 'gateway') return false;

  state.mode = mode;
  state.nodeCount = Array.isArray(nodeState.nodes) ? nodeState.nodes.length : state.nodeCount;
  state.chaos.nodeKilled = nodeState.nodes?.find(node => node.status === 'down')?.nodeId ?? null;
  const slowedNode = nodeState.nodes?.find(node => Number(node.chaos?.delayMs) > 0);
  const droppedNode = nodeState.nodes?.find(node => Number(node.chaos?.dropPercent) > 0);
  state.chaos.slowNode = slowedNode?.nodeId ?? null;
  state.chaos.slowNodeMs = Number(slowedNode?.chaos?.delayMs) || 0;
  state.chaos.dropRate = Number(droppedNode?.chaos?.dropPercent) || 0;
  state.chaos.dropNodeId = droppedNode?.nodeId ?? null;
  state.metrics = {
    throughput: Math.round(Number(metrics?.throughputPerSec) || 0),
    latencyP50: Number(metrics?.p50Ms) || 0,
    latencyP95: Number(metrics?.p95Ms) || 0,
    errorRate: Number(metrics?.errorRate) || 0,
    openConnections: Number(nodeState.openConnections) || 0,
    failedNodeDetectionMs: metrics?.detectMs ?? null,
  };
  state.source = 'live';
  state.liveError = null;
  for (const modeName of ['mesh', 'gateway']) {
    const lastRun = nodeState.metrics?.lastRun?.[modeName];
    if (lastRun && typeof lastRun === 'object') {
      state.scenario.results[modeName] = {
        ...state.scenario.results[modeName],
        throughput: Number(lastRun.throughput ?? lastRun.throughputPerSec) || 0,
        latencyP50: Number(lastRun.p50 ?? lastRun.p50Ms) || 0,
        latencyP95: Number(lastRun.p95 ?? lastRun.p95Ms) || 0,
        errorRate: Number(lastRun.errorRate) || 0,
        failedNodeDetectionMs: lastRun.detectMsAvg ?? lastRun.detectMs ?? lastRun.failedNodeDetectionMs ?? null,
        openConnections: Number(lastRun.openConnections) || 0,
        nodeCount: Number(lastRun.nodeCount ?? lastRun.nodes) || 0,
        durationMs: Number(lastRun.durationMs ?? lastRun.duration) || 0,
        endedAt: lastRun.endedTs ?? null,
        capturedAt: state.scenario.results[modeName]?.capturedAt || new Date().toISOString(),
      };
    }
  }
  return true;
}

async function syncLiveState(state) {
  try {
    const nodeState = await loopbackApi(NODE_API.state);
    if (!syncNodeState(state, nodeState)) throw new Error('Node API returned an unsupported mode.');
  } catch (err) {
    state.source = 'simulation';
    state.liveError = err.message;
    simulateMetrics(state);
    return state;
  }

  try {
    syncGatewayHealth(state, await loopbackApi(GATEWAY_API.state));
  } catch {
    state.gateway.available = false;
  }

  state.updatedAt = new Date().toISOString();
  return state;
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

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function scenarioIsCurrent(dataDir, runId) {
  const state = readState(dataDir);
  return state.running && state.scenario.runId === runId;
}

async function updateScenario(dataDir, runId, update) {
  const state = readState(dataDir);
  if (!state.running || state.scenario.runId !== runId) return false;
  update(state);
  state.updatedAt = new Date().toISOString();
  writeState(dataDir, state);
  return true;
}

async function latestNodeEventSeq() {
  let page = await loopbackApi(NODE_API.events, 'GET', undefined, { since: 0 });
  while (page.more) {
    page = await loopbackApi(NODE_API.events, 'GET', undefined, { since: page.seq });
  }
  return Number(page.seq) || 0;
}

async function collectNodeEvents(since) {
  const events = [];
  let page = await loopbackApi(NODE_API.events, 'GET', undefined, { since });
  events.push(...(Array.isArray(page.events) ? page.events : []));
  while (page.more) {
    page = await loopbackApi(NODE_API.events, 'GET', undefined, { since: page.seq });
    events.push(...(Array.isArray(page.events) ? page.events : []));
  }
  return { seq: Number(page.seq) || since, events };
}

async function waitForNodeDown(dataDir, runId, nodeId, since) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (!scenarioIsCurrent(dataDir, runId)) throw new Error('Demo run was cancelled.');
    const collected = await collectNodeEvents(since);
    const event = collected.events.find(item => (
      ['node.down', 'node-down'].includes(item.type ?? item.kind)
      && (item.to ?? item.nodeId) === nodeId
    ));
    if (event) return event;
    if (collected.seq > since) since = collected.seq;
    await wait(250);
  }
  throw new GatewayAdminError(`Timed out waiting for ${nodeId} to be reported down.`, 504);
}

function metricSnapshot(state) {
  return {
    throughput: state.metrics.throughput,
    latencyP50: state.metrics.latencyP50,
    latencyP95: state.metrics.latencyP95,
    errorRate: state.metrics.errorRate,
    failedNodeDetectionMs: state.metrics.failedNodeDetectionMs,
    openConnections: state.metrics.openConnections,
    nodeCount: state.nodeCount,
    capturedAt: new Date().toISOString(),
  };
}

function applyLiveSnapshot(target, liveState) {
  target.mode = liveState.mode;
  target.nodeCount = liveState.nodeCount;
  target.source = liveState.source;
  target.liveError = liveState.liveError;
  target.traffic = { ...target.traffic, ...liveState.traffic };
  target.chaos = { ...target.chaos, ...liveState.chaos };
  target.gateway = { ...target.gateway, ...liveState.gateway };
  target.metrics = { ...liveState.metrics };
  target.scenario.results = { ...target.scenario.results, ...liveState.scenario.results };
}

async function setDropChaos(state, dropRate) {
  const nodeState = await loopbackApi(NODE_API.state);
  const currentTarget = state.chaos.dropNodeId
    || nodeState.nodes?.find(node => Number(node.chaos?.dropPercent) > 0)?.nodeId;
  const target = dropRate > 0
    ? currentTarget || nodeState.nodes?.find(node => (
      node.status === 'up'
      && Number(node.chaos?.dropPercent) === 0
      && Number(node.chaos?.delayMs) === 0
      && node.nodeId !== state.chaos.nodeKilled
    ))?.nodeId
    : currentTarget;
  if (dropRate > 0 && !target) throw new GatewayAdminError('No healthy node is available for message-drop chaos.', 409, state);
  if (!target) {
    state.chaos.dropRate = 0;
    state.chaos.dropNodeId = null;
    return;
  }

  await loopbackApi(NODE_API.chaos, 'POST', { action: 'drop', nodeId: target, percent: dropRate });
  state.chaos.dropRate = dropRate;
  state.chaos.dropNodeId = dropRate > 0 ? target : null;
}

async function runDemoStep(dataDir, runId, step, operation) {
  if (!scenarioIsCurrent(dataDir, runId)) return;
  await updateScenario(dataDir, runId, state => { state.scenario.step = step; });
  const from = await latestNodeEventSeq();
  await operation(from);
  const collected = await collectNodeEvents(from);
  await updateScenario(dataDir, runId, state => {
    state.scenario.eventCursors[step] = { from, to: collected.seq };
    for (const event of collected.events) {
      const details = [event.type, event.from && `from ${event.from}`, event.to && `to ${event.to}`, event.errorCode]
        .filter(Boolean).join(' ');
      recordEvent(state, dataDir, 'live', details || 'Live NodeLink event');
    }
  });
}

async function runLiveDemo(dataDir, runId) {
  const ensureCurrent = () => {
    if (!scenarioIsCurrent(dataDir, runId)) throw new Error('Demo run was cancelled.');
  };

  await runDemoStep(dataDir, runId, 'Preparing five-node mesh', async () => {
    ensureCurrent();
    await gatewayAdmin('revive');
    await gatewayAdmin('reset');
    await loopbackApi(NODE_API.reset, 'POST', { nodes: 5, mode: 'mesh' });
    await loopbackApi(NODE_API.traffic, 'POST', {
      rate: 120,
      mix: { request: 60, oneway: 13, broadcast: 7 },
      payloadBytes: 256,
    });
    await updateScenario(dataDir, runId, state => {
      state.traffic = { ...state.traffic, rate: 120, payloadBytes: 256, dropRate: 0 };
      state.mode = 'mesh';
      state.source = 'live';
    });
  });

  await runDemoStep(dataDir, runId, 'Measuring five-node mesh baseline', async () => {
    await wait(10000);
    ensureCurrent();
    const state = await syncLiveState(readState(dataDir));
    await updateScenario(dataDir, runId, current => {
      applyLiveSnapshot(current, state);
      current.scenario.baseline = { ...metricSnapshot(current), nodeCount: 5 };
    });
  });

  await runDemoStep(dataDir, runId, 'Scaling mesh to fifteen nodes', async () => {
    ensureCurrent();
    await loopbackApi(NODE_API.nodes, 'POST', { count: 10, external: false });
    const state = await syncLiveState(readState(dataDir));
    await updateScenario(dataDir, runId, current => applyLiveSnapshot(current, state));
  });

  await runDemoStep(dataDir, runId, 'Measuring fifteen-node mesh traffic', async () => {
    await wait(10000);
    ensureCurrent();
    const state = await syncLiveState(readState(dataDir));
    await updateScenario(dataDir, runId, current => applyLiveSnapshot(current, state));
  });

  await runDemoStep(dataDir, runId, 'Detecting mesh node failure', async from => {
    ensureCurrent();
    const killedAt = Date.now();
    await loopbackApi(NODE_API.chaos, 'POST', { action: 'kill', nodeId: 'n2' });
    await waitForNodeDown(dataDir, runId, 'n2', from);
    const detectedMs = Math.max(0, Date.now() - killedAt);
    const state = await syncLiveState(readState(dataDir));
    await updateScenario(dataDir, runId, current => {
      applyLiveSnapshot(current, state);
      current.scenario.detection.mesh = detectedMs;
    });
  });

  await runDemoStep(dataDir, runId, 'Switching the same 15 nodes to gateway mode', async () => {
    ensureCurrent();
    const result = await loopbackApi(NODE_API.mode, 'POST', { mode: 'gateway' });
    if (result?.mode !== 'gateway') throw new Error('NodeLink did not enter gateway mode.');
    const state = await syncLiveState(readState(dataDir));
    await updateScenario(dataDir, runId, current => applyLiveSnapshot(current, state));
  });

  await runDemoStep(dataDir, runId, 'Restoring the node and configuring gateway traffic', async () => {
    ensureCurrent();
    await loopbackApi(NODE_API.chaos, 'POST', { action: 'revive', nodeId: 'n2' });
    await loopbackApi(NODE_API.traffic, 'POST', {
      rate: 120,
      mix: { request: 60, oneway: 13, broadcast: 7 },
      payloadBytes: 256,
    });
    const state = await syncLiveState(readState(dataDir));
    await updateScenario(dataDir, runId, current => applyLiveSnapshot(current, state));
  });

  await runDemoStep(dataDir, runId, 'Measuring fifteen-node gateway traffic', async () => {
    await wait(10000);
    ensureCurrent();
    const state = await syncLiveState(readState(dataDir));
    let gatewayMetrics = null;
    try {
      const metrics = await loopbackApi(GATEWAY_API.metrics);
      gatewayMetrics = {
        routed: Number(metrics.routed) || 0,
        retries: Number(metrics.retries) || 0,
        rateLimited: Number(metrics.rateLimited) || 0,
        p50Ms: Number(metrics.p50Ms) || 0,
        p95Ms: Number(metrics.p95Ms) || 0,
        detectMs: metrics.detectMs ?? null,
      };
    } catch {
      // The NodeLink mode metrics remain authoritative when optional gateway metrics are unavailable.
    }
    await updateScenario(dataDir, runId, current => {
      applyLiveSnapshot(current, state);
      if (current.scenario.results.gateway) {
        current.scenario.results.gateway.gatewayMetrics = gatewayMetrics;
      }
    });
  });

  await runDemoStep(dataDir, runId, 'Detecting gateway-mode node failure', async from => {
    ensureCurrent();
    const killedAt = Date.now();
    await loopbackApi(NODE_API.chaos, 'POST', { action: 'kill', nodeId: 'n2' });
    await waitForNodeDown(dataDir, runId, 'n2', from);
    const detectedMs = Math.max(0, Date.now() - killedAt);
    const state = await syncLiveState(readState(dataDir));
    await updateScenario(dataDir, runId, current => {
      applyLiveSnapshot(current, state);
      current.scenario.detection.gateway = detectedMs;
    });
  });

  await runDemoStep(dataDir, runId, 'Checking gateway failure and HA recovery', async () => {
    ensureCurrent();
    const down = await gatewayAdmin('kill');
    await updateScenario(dataDir, runId, state => syncGatewayHealth(state, down));
    await wait(1000);
    const revived = await gatewayAdmin('revive');
    await updateScenario(dataDir, runId, state => syncGatewayHealth(state, revived));
    const beforeHa = await loopbackApi(GATEWAY_API.state);
    if (beforeHa.ha && typeof beforeHa.ha.enabled === 'boolean') {
      const failoversBefore = Number(beforeHa.ha.failovers) || 0;
      await gatewayAdmin('ha', { enabled: true, detectMs: 1000 });
      const enabled = await loopbackApi(GATEWAY_API.state);
      if (!enabled.ha?.enabled) throw new Error('Gateway HA did not enable.');
      await gatewayAdmin('kill');
      await wait(Math.max(1000, Number(enabled.ha.detectMs) || 1000) + 500);
      const afterFailover = await loopbackApi(GATEWAY_API.state);
      const nodeStateAfterFailover = await loopbackApi(NODE_API.state);
      const unexpectedDownNodes = nodeStateAfterFailover.nodes
        ?.filter(node => node.status === 'down' && node.nodeId !== 'n2') || [];
      if (!afterFailover.ha?.enabled
        || Number(afterFailover.ha.failovers) <= failoversBefore
        || (afterFailover.gateway?.status ?? afterFailover.status) !== 'up'
        || unexpectedDownNodes.length) {
        throw new Error('Gateway HA failover was not observed.');
      }
      await gatewayAdmin('revive');
      const disabled = await gatewayAdmin('ha', { enabled: false });
      await updateScenario(dataDir, runId, state => syncGatewayHealth(state, disabled));
    } else {
      await updateScenario(dataDir, runId, state => {
        state.scenario.step = 'HA stretch unavailable';
        state.gateway.ha = null;
        state.gateway.haEnabled = false;
      });
    }
    await loopbackApi(NODE_API.traffic, 'POST', { rate: 0 });
    const state = await syncLiveState(readState(dataDir));
    let gatewayMetrics = null;
    try {
      const metrics = await loopbackApi(GATEWAY_API.metrics);
      gatewayMetrics = {
        routed: Number(metrics.routed) || 0,
        retries: Number(metrics.retries) || 0,
        rateLimited: Number(metrics.rateLimited) || 0,
        p50Ms: Number(metrics.p50Ms) || 0,
        p95Ms: Number(metrics.p95Ms) || 0,
        detectMs: metrics.detectMs ?? null,
      };
    } catch {
      // The NodeLink mode metrics remain authoritative when optional gateway metrics are unavailable.
    }
    await updateScenario(dataDir, runId, current => {
      applyLiveSnapshot(current, state);
      if (current.scenario.results.gateway) {
        current.scenario.results.gateway.gatewayMetrics = gatewayMetrics;
      }
    });
  });

  await updateScenario(dataDir, runId, state => {
    state.running = false;
    state.scenario.step = 'Demo complete';
    state.source = 'live';
    recordEvent(state, dataDir, 'scenario', 'Live mesh/gateway demo completed');
  });
}

async function finishDemo(dataDir, runId, err) {
  try {
    await loopbackApi(NODE_API.traffic, 'POST', { rate: 0 });
  } catch {
    // Best-effort cleanup; keep the original demo failure visible.
  }
  try {
    await gatewayAdmin('revive');
    await gatewayAdmin('ha', { enabled: false });
  } catch {
    // Keep the failure visible if the optional HA cleanup is unsupported.
  }
  await updateScenario(dataDir, runId, state => {
    state.running = false;
    state.scenario.step = `Demo paused: ${err.message}`;
    state.liveError = err.message;
    recordEvent(state, dataDir, 'scenario', `Demo failed: ${err.message}`);
  });
}

async function applyAction(state, dataDir, action, payload={}) {
  if (state.running && action !== 'start-scenario') {
    throw new GatewayAdminError('Controls are locked while the demo is running.', 409, state);
  }
  switch (action) {
    case 'toggle-mode': {
      const nextMode = state.mode === 'mesh' ? 'gateway' : 'mesh';
      if (nextMode === 'gateway') {
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
      await loopbackApi(NODE_API.mode, 'POST', { mode: nextMode });
      syncNodeState(state, await loopbackApi(NODE_API.state));
      state.scenario.step = state.mode === 'mesh' ? 'mesh active' : 'gateway active';
      recordEvent(state, dataDir, 'mode', `Mode switched to ${state.mode}`);
      break;
    }
    case 'set-traffic': {
      const rate = clamp(Number(payload.rate ?? state.traffic.rate), 10, 500);
      const payloadBytes = clamp(Number(payload.payloadBytes ?? state.traffic.payloadBytes), 64, 4096);
      const dropRate = clamp(Number(payload.dropRate ?? state.chaos.dropRate ?? state.traffic.dropRate ?? 0), 0, 100);
      await loopbackApi(NODE_API.traffic, 'POST', {
        rate,
        mix: { request: 60, oneway: 33, broadcast: 7 },
        payloadBytes,
      });
      if (payload.dropRate !== undefined) await setDropChaos(state, dropRate);
      state.traffic.rate = rate;
      state.traffic.payloadBytes = payloadBytes;
      state.chaos.dropRate = dropRate;
      syncNodeState(state, await loopbackApi(NODE_API.state));
      state.scenario.step = 'traffic tuned';
      recordEvent(state, dataDir, 'traffic', `Traffic set to ${rate} msg/s, payload ${payloadBytes} bytes, drop ${dropRate}%`);
      break;
    }
    case 'start-scenario': {
      if (state.running) throw new GatewayAdminError('A demo is already running.', 409, state);
      state.running = true;
      state.scenario.name = payload.name || 'live-demo';
      state.scenario.runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      state.scenario.results = { mesh: null, gateway: null };
      state.scenario.baseline = null;
      state.scenario.detection = { mesh: null, gateway: null };
      state.scenario.eventCursors = {};
      state.scenario.step = 'Starting live scenario';
      recordEvent(state, dataDir, 'scenario', `Scenario started: ${state.scenario.name}`);
      const runId = state.scenario.runId;
      setImmediate(() => {
        runLiveDemo(dataDir, runId).catch(err => finishDemo(dataDir, runId, err));
      });
      break;
    }
    case 'kill-node': {
      const nodeId = Number(payload.nodeId ?? state.chaos.nodeKilled ?? 2);
      await loopbackApi(NODE_API.chaos, 'POST', { action: 'kill', nodeId: `n${nodeId}` });
      state.chaos.nodeKilled = Number.isFinite(nodeId) ? nodeId : null;
      syncNodeState(state, await loopbackApi(NODE_API.state));
      state.scenario.step = state.chaos.nodeKilled !== null ? 'node failed' : 'ready';
      recordEvent(state, dataDir, 'fault', state.chaos.nodeKilled !== null ? `Node ${state.chaos.nodeKilled} failed` : 'Node failure cleared');
      break;
    }
    case 'slow-node': {
      const nodeId = Number(payload.nodeId ?? 3);
      const latencyMs = clamp(Number(payload.latencyMs ?? 3000), 500, 10000);
      await loopbackApi(NODE_API.chaos, 'POST', { action: 'slow', nodeId: `n${nodeId}`, delayMs: latencyMs });
      state.chaos.slowNode = Number.isFinite(nodeId) ? nodeId : null;
      state.chaos.slowNodeMs = latencyMs;
      syncNodeState(state, await loopbackApi(NODE_API.state));
      state.scenario.step = state.chaos.slowNode !== null ? 'node slowed' : 'ready';
      recordEvent(state, dataDir, 'fault', state.chaos.slowNode !== null ? `Node ${state.chaos.slowNode} slowed to ${latencyMs} ms` : 'Slow-node fault cleared');
      break;
    }
    case 'drop-messages': {
      const dropRate = clamp(Number(payload.dropRate ?? state.chaos.dropRate ?? 0), 0, 100);
      await setDropChaos(state, dropRate);
      syncNodeState(state, await loopbackApi(NODE_API.state));
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
      const enabled = !state.gateway.haEnabled;
      const gatewayState = await gatewayAdmin('ha', {
        enabled,
        detectMs: Number(state.gateway.ha?.detectMs) || 1000,
      });
      syncGatewayHealth(state, gatewayState);
      state.scenario.step = state.gateway.haEnabled ? 'ha active' : 'ha standby';
      recordEvent(state, dataDir, 'gateway', `HA pair ${state.gateway.haEnabled ? 'enabled' : 'disabled'}`);
      break;
    }
    case 'reset': {
      const previousHealth = state.gateway.healthy;
      const gatewayState = await gatewayAdmin('reset');
      const status = gatewayState?.gateway?.status ?? gatewayState?.status;
      await loopbackApi(NODE_API.reset, 'POST', { nodes: 5, mode: 'mesh' });
      const fresh = defaultState();
      fresh.gateway.available = true;
      fresh.gateway.healthy = status === 'down'
        ? false
        : status === 'up'
          ? true
          : previousHealth;
      Object.assign(state, fresh);
      syncNodeState(state, await loopbackApi(NODE_API.state));
      recordEvent(state, dataDir, 'scenario', 'System reset to baseline');
      break;
    }
    default:
      throw new Error(`Unsupported action: ${action}`);
  }

  if (state.source !== 'live') simulateMetrics(state);
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
    if (fresh.running) {
      fresh.running = false;
      fresh.scenario.step = 'Demo interrupted by restart';
    }
    if (!fresh.events || !fresh.events.length) {
      fresh.events = [{ type: 'system', text: 'Control module initialized', ts: Date.now() }];
    }
    writeState(ctx.dataDir, fresh);
    writeEvents(ctx.dataDir, fresh.events);
  },

  async handle(req, res, { path, dataDir, team }) {
    const state = readState(dataDir);

    if (req.method === 'GET' && path === '/status') {
      const nextState = await syncLiveState(state);
      writeState(dataDir, nextState);
      const summary = summaryText(nextState);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        team,
        summary,
        mode: nextState.mode,
        nodeCount: nextState.nodeCount,
        source: nextState.source,
        throughput: nextState.metrics.throughput,
        latencyP95: nextState.metrics.latencyP95,
        errorRate: nextState.metrics.errorRate,
        openConnections: nextState.metrics.openConnections,
        events: nextState.events,
      }));
      return true;
    }

    if (req.method === 'GET' && path === '/api/state') {
      const nextState = await syncLiveState(readState(dataDir));
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
