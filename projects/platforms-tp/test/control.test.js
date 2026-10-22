const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const plugin = require('../../../board/plugins/platforms-tp');
const dataDir = path.join(__dirname, '.test-data');
const originalFetch = global.fetch;
const originalSetTimeout = global.setTimeout;
const originalPort = process.env.PORT;

test.beforeEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.PORT = '17891';
});

test.afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  global.fetch = originalFetch;
  global.setTimeout = originalSetTimeout;
  if (originalPort === undefined) delete process.env.PORT;
  else process.env.PORT = originalPort;
});

function responseWithGatewayStatus(status) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, state: { gateway: { status } } }),
  };
}

function responseWithJson(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function nodeState(mode = 'mesh') {
  return {
    mode,
    nodes: [{ nodeId: 'n1', status: 'up', chaos: { delayMs: 0, dropPercent: 0 } }],
    openConnections: 4,
    metrics: {
      mesh: { throughputPerSec: 8.5, p50Ms: 2, p95Ms: 5, errorRate: 0, detectMs: null },
      gateway: { throughputPerSec: 7, p50Ms: 3, p95Ms: 8, errorRate: 0.01, detectMs: 1000 },
    },
  };
}

async function control(action, extra = {}) {
  const req = new EventEmitter();
  req.method = 'POST';
  req.headers = { host: 'untrusted.example' };
  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify({ action, ...extra })));
    req.emit('end');
  });

  const res = {
    status: null,
    body: null,
    writeHead(status) { this.status = status; },
    end(body) { this.body = JSON.parse(body); },
  };

  await plugin.handle(req, res, { path: '/api/control', dataDir, team: 'platforms-tp' });
  return res;
}

async function getState() {
  const req = new EventEmitter();
  req.method = 'GET';
  const res = {
    status: null,
    body: null,
    writeHead(status) { this.status = status; },
    end(body) { this.body = JSON.parse(body); },
  };
  await plugin.handle(req, res, { path: '/api/state', dataDir, team: 'platforms-tp' });
  return res;
}

test('toggle-gateway calls the local Pisak admin API and syncs its state', async () => {
  global.fetch = async (url, options) => {
    const target = new URL(url);
    assert.equal(target.hostname, '127.0.0.1');
    assert.equal(target.port, '17891');
    assert.equal(target.pathname, '/t/pisak/api/admin');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'manual');
    assert.deepEqual(JSON.parse(options.body), { action: 'kill' });
    return responseWithGatewayStatus('down');
  };

  const result = await control('toggle-gateway');
  assert.equal(result.status, 200);
  assert.equal(result.body.state.gateway.healthy, false);
});

test('toggle-ha forwards the enabled state to Pisak', async () => {
  global.fetch = async (url, options) => {
    const target = new URL(url);
    assert.equal(target.pathname, '/t/pisak/api/admin');
    assert.deepEqual(JSON.parse(options.body), { action: 'ha', enabled: true, detectMs: 1000 });
    return responseWithJson({
      ok: true,
      state: { gateway: { status: 'up' }, ha: { enabled: true, active: 'a', detectMs: 1000, failovers: 0 } },
    });
  };

  const result = await control('toggle-ha');
  assert.equal(result.status, 200);
  assert.equal(result.body.state.gateway.haEnabled, true);
  assert.equal(result.body.state.gateway.ha.active, 'a');
});

test('gateway admin redirects are rejected without following them', async () => {
  global.fetch = async (_url, options) => {
    assert.equal(options.redirect, 'manual');
    return {
      ok: false,
      status: 307,
      json: async () => assert.fail('redirect response must not be parsed'),
    };
  };

  const result = await control('toggle-gateway');
  assert.equal(result.status, 502);
  assert.match(result.body.error, /unexpected redirect/);
});

test('reset preserves a killed gateway', async () => {
  global.fetch = async (url, options) => {
    const target = new URL(url);
    if (target.pathname === '/t/pisak/api/admin') {
      assert.deepEqual(JSON.parse(options.body), { action: 'reset' });
      return responseWithGatewayStatus('down');
    }
    if (target.pathname === '/t/farzad/api/reset') {
      assert.deepEqual(JSON.parse(options.body), { nodes: 5, mode: 'mesh' });
      return responseWithJson({ mode: 'mesh', nodes: ['n1', 'n2', 'n3', 'n4', 'n5'] });
    }
    if (target.pathname === '/t/farzad/api/state') return responseWithJson(nodeState());
    assert.fail(`unexpected upstream path ${target.pathname}`);
  };

  const result = await control('reset');
  assert.equal(result.status, 200);
  assert.equal(result.body.state.mode, 'mesh');
  assert.equal(result.body.state.gateway.healthy, false);
});

test('a killed gateway cannot be switched into gateway mode', async () => {
  global.fetch = async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body), { action: 'reset' });
    return responseWithGatewayStatus('down');
  };

  const result = await control('toggle-mode');
  assert.equal(result.status, 503);
  assert.match(result.body.error, /Gateway is down/);
  assert.equal(result.body.state.mode, 'mesh');
  assert.equal(result.body.state.gateway.healthy, false);
});

test('gateway mode starts only after the pre-run reset succeeds', async () => {
  global.fetch = async (_url, options) => {
    const target = new URL(_url);
    if (target.pathname === '/t/pisak/api/admin') {
      assert.deepEqual(JSON.parse(options.body), { action: 'reset' });
      return responseWithGatewayStatus('up');
    }
    if (target.pathname === '/t/farzad/api/mode') {
      assert.deepEqual(JSON.parse(options.body), { mode: 'gateway' });
      return responseWithJson({ mode: 'gateway', switchMs: 2, failed: [] });
    }
    if (target.pathname === '/t/farzad/api/state') return responseWithJson(nodeState('gateway'));
    assert.fail(`unexpected upstream path ${target.pathname}`);
  };

  const result = await control('toggle-mode');
  assert.equal(result.status, 200);
  assert.equal(result.body.state.mode, 'gateway');
  assert.equal(result.body.state.gateway.healthy, true);
  assert.equal(result.body.state.source, 'live');
});

test('an unavailable gateway returns an upstream error without changing simulated state', async () => {
  global.fetch = async () => {
    throw new Error('connection refused');
  };

  const result = await control('toggle-gateway');
  assert.equal(result.status, 502);
  assert.match(result.body.error, /Upstream API request failed/);
  assert.equal(result.body.state, undefined);
});

test('state reads live NodeLink metrics and labels them as live', async () => {
  global.fetch = async url => {
    const target = new URL(url);
    if (target.pathname === '/t/farzad/api/state') return responseWithJson(nodeState());
    if (target.pathname === '/t/pisak/api/state') return responseWithJson({ gateway: { status: 'up' } });
    assert.fail(`unexpected upstream path ${target.pathname}`);
  };

  const result = await getState();
  assert.equal(result.status, 200);
  assert.equal(result.body.source, 'live');
  assert.equal(result.body.metrics.throughput, 9);
  assert.equal(result.body.metrics.latencyP95, 5);
  assert.equal(result.body.metrics.openConnections, 4);
  assert.equal(result.body.nodeCount, 1);
  assert.equal(result.body.gateway.available, true);
});

test('state imports Farzad frozen per-mode metrics using the published fields', async () => {
  fs.writeFileSync(path.join(dataDir, 'platforms-tp.state.json'), JSON.stringify({
    scenario: { results: { gateway: { gatewayMetrics: { routed: 81, retries: 2 } } } },
  }));
  global.fetch = async url => {
    const target = new URL(url);
    if (target.pathname === '/t/farzad/api/state') {
      const state = nodeState();
      state.metrics.lastRun = {
        mesh: {
          p50: 4,
          p95: 9,
          throughput: 23,
          errorRate: 0.02,
          detectMsAvg: 3100,
          openConnections: 20,
          nodes: 5,
          durationMs: 12000,
          endedTs: 1700000000000,
        },
        gateway: {
          p50: 6,
          p95: 11,
          throughput: 18,
          errorRate: 0.03,
          detectMsAvg: null,
          openConnections: 5,
          nodes: 5,
          durationMs: 11000,
          endedTs: null,
        },
      };
      return responseWithJson(state);
    }
    if (target.pathname === '/t/pisak/api/state') return responseWithJson({ gateway: { status: 'up' } });
    assert.fail(`unexpected upstream path ${target.pathname}`);
  };

  const result = await getState();
  assert.deepEqual(result.body.scenario.results.mesh, {
    throughput: 23,
    latencyP50: 4,
    latencyP95: 9,
    errorRate: 0.02,
    failedNodeDetectionMs: 3100,
    openConnections: 20,
    nodeCount: 5,
    durationMs: 12000,
    endedAt: 1700000000000,
    capturedAt: result.body.scenario.results.mesh.capturedAt,
  });
  assert.ok(Number.isFinite(Date.parse(result.body.scenario.results.mesh.capturedAt)));
  assert.equal(result.body.scenario.results.gateway.failedNodeDetectionMs, null);
  assert.deepEqual(result.body.scenario.results.gateway.gatewayMetrics, { routed: 81, retries: 2 });
  const secondRead = await getState();
  assert.equal(secondRead.body.scenario.results.mesh.capturedAt, result.body.scenario.results.mesh.capturedAt);
});

test('state labels simulated metrics when the live Node API is unavailable', async () => {
  global.fetch = async () => { throw new Error('connection refused'); };

  const result = await getState();
  assert.equal(result.status, 200);
  assert.equal(result.body.source, 'simulation');
  assert.match(result.body.liveError, /connection refused/);
  assert.equal(result.body.metrics.throughput, 138);
});

test('traffic controls use supported send types and target a healthy node for drop chaos', async () => {
  const calls = [];
  let dropPercent = 0;
  global.fetch = async (url, options) => {
    const target = new URL(url);
    calls.push({ path: target.pathname, method: options.method, body: options.body && JSON.parse(options.body) });
    if (target.pathname === '/t/farzad/api/traffic') return responseWithJson({ rate: 180 });
    if (target.pathname === '/t/farzad/api/chaos') {
      dropPercent = Number(JSON.parse(options.body).percent) || 0;
      return responseWithJson({ nodeId: 'n1', status: 'up' });
    }
    if (target.pathname === '/t/farzad/api/state') {
      return responseWithJson({
        ...nodeState(),
        nodes: [{ nodeId: 'n1', status: 'up', chaos: { delayMs: 0, dropPercent } }],
      });
    }
    assert.fail(`unexpected upstream path ${target.pathname}`);
  };

  const result = await control('set-traffic', { rate: 180, payloadBytes: 512, dropRate: 5 });
  assert.equal(result.status, 200);
  assert.deepEqual(calls.map(({ path, method }) => [path, method]), [
    ['/t/farzad/api/traffic', 'POST'],
    ['/t/farzad/api/state', 'GET'],
    ['/t/farzad/api/chaos', 'POST'],
    ['/t/farzad/api/state', 'GET'],
  ]);
  assert.deepEqual(calls[0].body, {
    rate: 180,
    mix: { request: 60, oneway: 33, broadcast: 7 },
    payloadBytes: 512,
  });
  assert.deepEqual(calls[2].body, { action: 'drop', nodeId: 'n1', percent: 5 });
  assert.equal(result.body.state.source, 'live');
  assert.equal(result.body.state.traffic.rate, 180);
  assert.equal(result.body.state.chaos.dropNodeId, 'n1');
});

test('traffic changes without an explicit drop rate leave node chaos untouched', async () => {
  const calls = [];
  global.fetch = async (url, options) => {
    const target = new URL(url);
    calls.push({ path: target.pathname, method: options.method });
    if (target.pathname === '/t/farzad/api/traffic') return responseWithJson({ rate: 180 });
    if (target.pathname === '/t/farzad/api/state') return responseWithJson(nodeState());
    assert.fail(`unexpected upstream path ${target.pathname}`);
  };

  const result = await control('set-traffic', { rate: 180, payloadBytes: 512 });
  assert.equal(result.status, 200);
  assert.deepEqual(calls.map(({ path, method }) => [path, method]), [
    ['/t/farzad/api/traffic', 'POST'],
    ['/t/farzad/api/state', 'GET'],
  ]);
});

test('starting a demo reports upstream failure and unlocks controls', async () => {
  global.fetch = async () => responseWithJson({ error: { message: 'gateway unavailable' } }, 502);

  const result = await control('start-scenario');
  assert.equal(result.status, 200);
  assert.equal(result.body.state.running, true);

  await new Promise(resolve => setTimeout(resolve, 20));
  const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'platforms-tp.state.json'), 'utf8'));
  assert.equal(state.running, false);
  assert.match(state.scenario.step, /Demo paused/);
  assert.match(state.liveError, /gateway unavailable/);
  assert.equal(state.scenario.steps[0].status, 'failed');
  assert.match(state.scenario.steps[0].error, /gateway unavailable/);
});

test('live demo runs the same node-failure scenario in mesh and gateway modes', async () => {
  const calls = [];
  let mode = 'mesh';
  let nodeCount = 5;
  let nodeDown = false;
  let eventSeq = 0;
  const events = [];
  const ha = { enabled: false, active: 'a', detectMs: 1000, failovers: 0 };
  global.setTimeout = callback => {
    queueMicrotask(callback);
    return 0;
  };
  global.fetch = async (url, options) => {
    const target = new URL(url);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path: target.pathname, method: options.method, body });
    if (target.pathname === '/t/pisak/api/admin') {
      eventSeq += 1;
      let status = 'up';
      if (body.action === 'ha') ha.enabled = body.enabled;
      else if (body.action === 'kill' && ha.enabled) {
        ha.active = 'b';
        ha.failovers += 1;
      } else if (body.action === 'kill') status = 'down';
      return responseWithJson({ ok: true, state: { gateway: { status }, ha: { ...ha } } });
    }
    if (target.pathname === '/t/farzad/api/reset') {
      mode = body.mode;
      nodeCount = body.nodes;
      nodeDown = false;
      eventSeq += 1;
      return responseWithJson({ mode, nodes: ['n1', 'n2', 'n3', 'n4', 'n5'] });
    }
    if (target.pathname === '/t/farzad/api/nodes') {
      nodeCount += body.count;
      eventSeq += 1;
      return responseWithJson({ nodes: Array.from({ length: body.count }, (_, i) => `n${i + 6}`) }, 201);
    }
    if (target.pathname === '/t/farzad/api/traffic') {
      eventSeq += 1;
      return responseWithJson({ rate: body.rate });
    }
    if (target.pathname === '/t/farzad/api/chaos') {
      nodeDown = body.action === 'kill';
      eventSeq += 1;
      if (nodeDown) events.push({ seq: eventSeq, type: 'node.down', to: body.nodeId, ts: Date.now() });
      return responseWithJson({ nodeId: body.nodeId, status: nodeDown ? 'down' : 'up' });
    }
    if (target.pathname === '/t/farzad/api/mode') {
      mode = body.mode;
      eventSeq += 1;
      return responseWithJson({ mode, switchMs: 3, failed: [] });
    }
    if (target.pathname === '/t/farzad/api/state') {
      const nodes = Array.from({ length: nodeCount }, (_, i) => ({
        nodeId: `n${i + 1}`,
        status: nodeDown && i === 1 ? 'down' : 'up',
        chaos: { delayMs: 0, dropPercent: 0 },
      }));
      const snapshot = nodeState(mode);
      snapshot.metrics.lastRun = {
        mesh: mode === 'gateway' ? {
          p50Ms: 4,
          p95Ms: 9,
          throughputPerSec: 23,
          errorRate: 0.02,
          detectMsAvg: null,
          openConnections: 105,
          nodes: 15,
          durationMs: 12000,
          endedTs: 1700000000000,
        } : null,
        gateway: mode === 'gateway' ? {
          p50Ms: 6,
          p95Ms: 11,
          throughputPerSec: 18,
          errorRate: 0.03,
          detectMsAvg: null,
          openConnections: 17,
          nodes: 15,
          durationMs: 11000,
          endedTs: null,
        } : null,
      };
      return responseWithJson({
        ...snapshot,
        nodes,
        openConnections: mode === 'mesh' ? 105 : 17,
      });
    }
    if (target.pathname === '/t/farzad/api/events') {
      const since = Number(target.searchParams.get('since')) || 0;
      return responseWithJson({ seq: eventSeq, more: false, events: events.filter(event => event.seq > since) });
    }
    if (target.pathname === '/t/pisak/api/state') {
      return responseWithJson({ gateway: { status: 'up' }, ha: { ...ha } });
    }
    if (target.pathname === '/t/pisak/api/metrics') {
      return responseWithJson({ routed: 81, retries: 2, rateLimited: 1, p50Ms: 4, p95Ms: 12, detectMs: 1000 });
    }
    assert.fail(`unexpected upstream path ${target.pathname}`);
  };

  const result = await control('start-scenario');
  assert.equal(result.status, 200);
  for (let attempt = 0; attempt < 100 && JSON.parse(fs.readFileSync(path.join(dataDir, 'platforms-tp.state.json'), 'utf8')).running; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }

  const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'platforms-tp.state.json'), 'utf8'));
  assert.equal(state.running, false);
  assert.equal(state.scenario.step, 'Demo complete');
  assert.deepEqual(state.scenario.steps.map(step => step.id), [
    'start-mesh',
    'mesh-traffic',
    'scale-mesh',
    'mesh-failure',
    'gateway-replay',
    'gateway-ha',
    'comparison',
  ]);
  assert.ok(state.scenario.steps.every(step => step.status === 'done'));
  assert.equal(state.scenario.steps[2].metrics.nodeCount, 15);
  assert.notEqual(state.scenario.steps[3].metrics.detectionMs, null);
  assert.notEqual(state.scenario.steps[4].metrics.detectionMs, null);
  assert.equal(state.scenario.conclusion.lowerP95Mode, 'mesh');
  assert.equal(state.scenario.conclusion.fewerConnectionsMode, 'gateway');
  assert.equal(state.mode, 'gateway');
  assert.equal(state.source, 'live');
  assert.equal(state.scenario.baseline.nodeCount, 5);
  assert.equal(state.scenario.results.mesh.nodeCount, 15);
  assert.equal(state.scenario.results.gateway.nodeCount, 15);
  assert.equal(state.scenario.results.mesh.durationMs, 12000);
  assert.equal(state.scenario.results.gateway.durationMs, 11000);
  assert.equal(state.scenario.results.mesh.openConnections, 105);
  assert.equal(state.scenario.results.gateway.openConnections, 17);
  assert.notEqual(state.scenario.detection.mesh, null);
  assert.notEqual(state.scenario.detection.gateway, null);
  assert.equal(state.scenario.results.gateway.gatewayMetrics.routed, 81);
  assert.equal(state.gateway.haEnabled, false);
  assert.ok(calls.some(call => call.path === '/t/pisak/api/admin' && call.body.action === 'ha' && call.body.enabled === true));
  assert.ok(calls.some(call => call.path === '/t/pisak/api/admin' && call.body.action === 'ha' && call.body.enabled === false));
  assert.ok(calls.filter(call => call.path === '/t/pisak/api/admin' && call.body.action === 'kill').length >= 2);
  assert.ok(state.scenario.eventCursors['Measuring five-node mesh baseline']);
  assert.ok(state.scenario.eventCursors['Measuring fifteen-node mesh traffic']);
  assert.ok(state.scenario.eventCursors['Measuring fifteen-node gateway traffic']);
  assert.ok(calls.some(call => call.path === '/t/farzad/api/nodes' && call.body.count === 10));
  assert.equal(calls.filter(call => call.path === '/t/farzad/api/chaos' && call.body.action === 'kill' && call.body.nodeId === 'n2').length, 2);
  assert.ok(calls.some(call => call.path === '/t/farzad/api/mode' && call.body.mode === 'gateway'));
  assert.equal(calls.some(call => call.path === '/t/farzad/api/mode' && call.body.mode === 'mesh'), false);
  const scaleIndex = calls.findIndex(call => call.path === '/t/farzad/api/nodes');
  const firstStateRead = calls.findIndex(call => call.path === '/t/farzad/api/state');
  assert.ok(firstStateRead >= 0 && firstStateRead < scaleIndex);
});

test('manual controls are rejected while a persisted demo is running', async () => {
  fs.writeFileSync(path.join(dataDir, 'platforms-tp.state.json'), JSON.stringify({
    running: true,
    scenario: { runId: 'active-run', step: 'Measuring mesh traffic' },
  }));
  global.fetch = async () => assert.fail('locked actions must not call upstream APIs');

  const result = await control('toggle-mode');
  assert.equal(result.status, 409);
  assert.match(result.body.error, /locked while the demo is running/);
});

test('plugin restart fails the in-progress demo step visibly', () => {
  fs.writeFileSync(path.join(dataDir, 'platforms-tp.state.json'), JSON.stringify({
    running: true,
    scenario: {
      runId: 'interrupted-run',
      steps: [{
        id: 'gateway-replay',
        title: 'Repeat traffic and node failure in gateway mode',
        status: 'running',
        startedAt: '2026-10-22T10:50:00.000Z',
        completedAt: null,
        metrics: null,
      }],
    },
  }));

  plugin.init({ dataDir });
  const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'platforms-tp.state.json'), 'utf8'));
  assert.equal(state.running, false);
  assert.equal(state.scenario.step, 'Demo interrupted by restart');
  assert.equal(state.scenario.steps[0].status, 'failed');
  assert.match(state.scenario.steps[0].error, /interrupted by restart/);
  assert.ok(Number.isFinite(Date.parse(state.scenario.steps[0].completedAt)));
});
