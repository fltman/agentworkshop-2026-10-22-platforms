'use strict';
// Calls to the gateway (team pisak), CONTRACT.md section 6.
const { call } = require('./http');

const G = '/t/pisak';

function registration(node) {
  return {
    nodeId: node.id,
    apps: node.appList().map((a) => ({ appId: a.appId, listenerIds: a.listenerIds })),
    deliverUrl: `/t/farzad/n/${node.id}/deliver`,
    heartbeatUrl: `/t/farzad/n/${node.id}/heartbeat`,
    external: node.external,
  };
}

// Turns a failed gateway answer into a contract error. 'unreachable' tells the caller to mark the link down.
function failure(r) {
  if (r.timeout) return { code: 'TIMEOUT', at: 'gateway', message: 'no answer from the gateway in time', unreachable: true };
  if (r.neterr || !r.body || !r.body.error || !r.body.error.code) {
    return { code: 'NODE_UNAVAILABLE', at: 'gateway', message: 'gateway did not answer', unreachable: true };
  }
  const e = { ...r.body.error };
  if (!e.at) e.at = 'gateway';
  return { ...e, unreachable: e.code === 'NODE_UNAVAILABLE' };
}

async function register(node, timeoutMs = 2000) {
  const r = await call('POST', `${G}/api/register`, registration(node), { timeoutMs });
  if (r.status === 200 && r.body && typeof r.body.token === 'string') {
    const probeIntervalMs = Number(r.body.probeIntervalMs) > 0 ? Number(r.body.probeIntervalMs) : 1000;
    return { ok: true, token: r.body.token, probeIntervalMs };
  }
  return { ok: false, error: failure(r) };
}

function route(token, envelope, timeoutMs, signal) {
  return call('POST', `${G}/api/route`, envelope, { timeoutMs, signal, headers: { authorization: `Bearer ${token}` } });
}

function deregister(token, nodeId) {
  return call('POST', `${G}/api/deregister`, { nodeId }, { timeoutMs: 1500, headers: { authorization: `Bearer ${token}` } });
}

function events(since) { return call('GET', `${G}/api/events?since=${encodeURIComponent(since)}`, undefined, { timeoutMs: 1500 }); }

function reset() { return call('POST', `${G}/api/admin`, { action: 'reset' }, { timeoutMs: 1500 }); }

module.exports = { register, route, deregister, events, reset, failure };
