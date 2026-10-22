'use strict';
// Envelope rules from CONTRACT.md sections 1 and 2: validation, size, error objects and HTTP codes.
const PROTO = 'nodelink';
const VERSION = 2;
const MAX_BYTES = 65536;
const DEFAULT_TTL = 2000;
const TYPES = new Set(['request', 'response', 'oneway', 'broadcast']);
const HTTP = {
  UNKNOWN_NODE: 404, UNKNOWN_APP: 404, NO_LISTENER: 404, TIMEOUT: 504, NODE_UNAVAILABLE: 503,
  PEER_OVERLOADED: 503, MESSAGE_TOO_LARGE: 413, BAD_PROTOCOL: 400, MODE_SWITCH_FAILED: 502, MIN_NODES: 409, MAX_NODES: 409,
};

function error(code, at, message, reason) {
  const e = { code, at: at || 'node', message: message || code };
  if (reason) e.reason = reason;
  return e;
}

function statusOf(e) {
  if (e && e.code === 'REJECTED') return e.reason === 'rate_limit' ? 429 : 401;
  return (e && HTTP[e.code]) || 500;
}

function size(obj) { return Buffer.byteLength(JSON.stringify(obj), 'utf8'); }

function isAddr(a) {
  return !!a && typeof a === 'object' && !Array.isArray(a)
    && typeof a.nodeId === 'string' && a.nodeId !== ''
    && typeof a.appId === 'string' && a.appId !== ''
    && (a.listenerId === undefined || a.listenerId === null || typeof a.listenerId === 'string');
}

// Addressing rules shared by the sender and the receiver. Returns a reason string or null.
function addressingProblem(type, dest) {
  if (dest.nodeId === '*' && type !== 'broadcast') return 'nodeId "*" requires type broadcast';
  if (type === 'broadcast' && dest.nodeId !== '*') return 'a broadcast must have nodeId "*"';
  if (dest.nodeId === '*' && dest.listenerId != null) return 'listenerId must be null for nodeId "*"';
  return null;
}

// Full envelope validation. Returns null when valid, otherwise a reason (always BAD_PROTOCOL).
function validate(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return 'envelope is not an object';
  if (e.proto !== PROTO) return 'proto must be "nodelink"';
  if (e.version !== VERSION) return `unsupported version ${e.version}`;
  if (typeof e.messageId !== 'string' || !e.messageId) return 'messageId missing';
  if (!TYPES.has(e.type)) return `bad type ${e.type}`;
  if (!isAddr(e.source) || e.source.nodeId === '*') return 'bad source';
  if (!isAddr(e.destination)) return 'bad destination';
  if (typeof e.timestamp !== 'number' || !Number.isFinite(e.timestamp)) return 'timestamp missing';
  if (e.correlationId !== undefined && typeof e.correlationId !== 'string') return 'bad correlationId';
  if (e.ttlMs !== undefined && (typeof e.ttlMs !== 'number' || !(e.ttlMs > 0))) return 'bad ttlMs';
  if (e.msgTypeId !== undefined && e.msgTypeId !== null && (typeof e.msgTypeId !== 'number' || !Number.isFinite(e.msgTypeId))) return 'bad msgTypeId';
  if (e.scope !== undefined && e.scope !== 'cluster' && e.scope !== 'all') return 'bad scope';
  return addressingProblem(e.type, e.destination);
}

module.exports = { PROTO, VERSION, MAX_BYTES, DEFAULT_TTL, error, statusOf, size, validate, addressingProblem, isAddr };
