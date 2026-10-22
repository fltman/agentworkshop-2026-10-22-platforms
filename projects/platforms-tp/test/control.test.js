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
          duration: 12000,
        },
        gateway: {
          p50: 6,
          p95: 11,
          throughput: 18,
          errorRate: 0.03,
          detectMsAvg: 3000,
          openConnections: 5,
          nodes: 5,
          duration: 11000,
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
    capturedAt: result.body.scenario.results.mesh.capturedAt,
  });
  assert.ok(Number.isFinite(Date.parse(result.body.scenario.results.mesh.capturedAt)));
  assert.deepEqual(result.body.scenario.results.gateway.gatewayMetrics, { routed: 81, retries: 2 });
});

test('state labels simulated metrics when the live Node API is unavailable', async () => {
  global.fetch = async () => { throw new Error('connection refused'); };

  const result = await getState();
  assert.equal(result.status, 200);
  assert.equal(result.body.source, 'simulation');
  assert.match(result.body.liveError, /connection refused/);
  assert.equal(result.body.metrics.throughput, 138);
});

test('traffic controls update Farzad traffic and chaos APIs', async () => {
  const calls = [];
  global.fetch = async (url, options) => {
    const target = new URL(url);
    calls.push({ path: target.pathname, method: options.method, body: options.body && JSON.parse(options.body) });
    if (target.pathname === '/t/farzad/api/traffic') return responseWithJson({ rate: 180 });
    if (target.pathname === '/t/farzad/api/chaos') return responseWithJson({ nodeId: 'n2', status: 'up' });
    if (target.pathname === '/t/farzad/api/state') return responseWithJson(nodeState());
    assert.fail(`unexpected upstream path ${target.pathname}`);
  };

  const result = await control('set-traffic', { rate: 180, payloadBytes: 512, dropRate: 5 });
  assert.equal(result.status, 200);
  assert.deepEqual(calls.map(({ path, method }) => [path, method]), [
    ['/t/farzad/api/traffic', 'POST'],
    ['/t/farzad/api/chaos', 'POST'],
    ['/t/farzad/api/state', 'GET'],
  ]);
  assert.deepEqual(calls[0].body, {
    rate: 180,
    mix: { request: 60, oneway: 13, broadcast: 7 },
    payloadBytes: 512,
  });
  assert.deepEqual(calls[1].body, { action: 'drop', nodeId: 'n2', percent: 5 });
  assert.equal(result.body.state.source, 'live');
  assert.equal(result.body.state.traffic.rate, 180);
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
});

test('live demo runs the same node-failure scenario in mesh and gateway modes', async () => {
  const calls = [];
  let mode = 'mesh';
  let nodeDown = false;
  let eventSeq = 0;
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
      nodeDown = false;
      eventSeq += 1;
      return responseWithJson({ mode, nodes: ['n1', 'n2', 'n3', 'n4', 'n5'] });
    }
    if (target.pathname === '/t/farzad/api/nodes') {
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
      return responseWithJson({ nodeId: body.nodeId, status: nodeDown ? 'down' : 'up' });
    }
    if (target.pathname === '/t/farzad/api/mode') {
      mode = body.mode;
      eventSeq += 1;
      return responseWithJson({ mode, switchMs: 3, failed: [] });
    }
    if (target.pathname === '/t/farzad/api/state') {
      const nodes = Array.from({ length: 15 }, (_, i) => ({
        nodeId: `n${i + 1}`,
        status: nodeDown && i === 1 ? 'down' : 'up',
        chaos: { delayMs: 0, dropPercent: 0 },
      }));
      return responseWithJson({
        ...nodeState(mode),
        nodes,
        openConnections: mode === 'mesh' ? 196 : 14,
      });
    }
    if (target.pathname === '/t/farzad/api/events') {
      return responseWithJson({ seq: eventSeq, more: false, events: [] });
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
  assert.equal(state.mode, 'mesh');
  assert.equal(state.source, 'live');
  assert.equal(state.scenario.results.mesh.nodeCount, 15);
  assert.equal(state.scenario.results.gateway.nodeCount, 15);
  assert.equal(state.scenario.results.gateway.gatewayMetrics.routed, 81);
  assert.equal(state.gateway.haEnabled, false);
  assert.ok(calls.some(call => call.path === '/t/pisak/api/admin' && call.body.action === 'ha' && call.body.enabled === true));
  assert.ok(calls.some(call => call.path === '/t/pisak/api/admin' && call.body.action === 'ha' && call.body.enabled === false));
  assert.ok(calls.filter(call => call.path === '/t/pisak/api/admin' && call.body.action === 'kill').length >= 2);
  assert.ok(state.scenario.eventCursors['Measuring mesh traffic']);
  assert.ok(state.scenario.eventCursors['Measuring gateway traffic']);
  assert.ok(calls.some(call => call.path === '/t/farzad/api/nodes' && call.body.count === 10));
  assert.ok(calls.some(call => call.path === '/t/farzad/api/chaos' && call.body.action === 'kill' && call.body.nodeId === 'n2'));
  assert.ok(calls.some(call => call.path === '/t/farzad/api/mode' && call.body.mode === 'gateway'));
  assert.ok(calls.some(call => call.path === '/t/farzad/api/mode' && call.body.mode === 'mesh'));
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
