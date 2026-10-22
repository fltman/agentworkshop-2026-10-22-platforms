const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const plugin = require('../../../board/plugins/platforms-tp');
const dataDir = path.join(__dirname, '.test-data');
const originalFetch = global.fetch;
const originalPort = process.env.PORT;

test.beforeEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.PORT = '17891';
});

test.afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  global.fetch = originalFetch;
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

async function control(action) {
  const req = new EventEmitter();
  req.method = 'POST';
  req.headers = { host: 'untrusted.example' };
  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify({ action })));
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
  global.fetch = async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body), { action: 'reset' });
    return responseWithGatewayStatus('down');
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
    assert.deepEqual(JSON.parse(options.body), { action: 'reset' });
    return responseWithGatewayStatus('up');
  };

  const result = await control('toggle-mode');
  assert.equal(result.status, 200);
  assert.equal(result.body.state.mode, 'gateway');
  assert.equal(result.body.state.gateway.healthy, true);
});

test('an unavailable gateway returns an upstream error without changing simulated state', async () => {
  global.fetch = async () => {
    throw new Error('connection refused');
  };

  const result = await control('toggle-gateway');
  assert.equal(result.status, 502);
  assert.match(result.body.error, /Gateway admin request failed/);
  assert.equal(result.body.state, undefined);
});
