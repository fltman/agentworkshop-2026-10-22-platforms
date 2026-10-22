'use strict';
// Metrics (60 s window) and the event log (ring buffer + SSE) for the NodeLink gateway.

const EVENT_BUFFER = 2000;
const WINDOW_MS = 10000; // the same rolling window as farzad's mesh metrics, so the two modes compare
const MAX_SAMPLES = 20000;
const MAX_SSE_BACKLOG = 1 << 20;

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1))];
}
const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

class Events {
  constructor() {
    this.seq = 0;               // never reset: clients resume from it
    this.dropped = 0;           // highest seq no longer in the buffer (overflow or reset)
    this.buf = [];
    this.clients = new Set();
    this.maxMessagesPerSec = 50; // message events beyond this are sampled
    this.msgSec = 0; this.msgCount = 0; this.msgSkipped = 0;
  }

  emit(kind, fields) {
    if (kind === 'message') {
      const sec = Math.floor(Date.now() / 1000);
      if (sec !== this.msgSec) { this.msgSec = sec; this.msgCount = 0; }
      if (this.msgCount >= this.maxMessagesPerSec) { this.msgSkipped++; return null; }
      this.msgCount++;
      if (this.msgSkipped) { fields = { ...fields, sampled: true, skipped: this.msgSkipped }; this.msgSkipped = 0; }
    }
    const seq = ++this.seq;
    const ev = { seq, id: seq, ts: Date.now(), kind, mode: 'gateway',
      from: null, to: null, ok: null, latencyMs: null, errorCode: null, ...fields };
    this.buf.push(ev);
    if (this.buf.length > EVENT_BUFFER) this.dropped = this.buf.splice(0, this.buf.length - EVENT_BUFFER).pop().seq;
    for (const c of this.clients) this.send(c, ev);
    return ev;
  }

  // since given: the oldest `limit` events after it. since missing: the latest `limit` events.
  // more: further events are already waiting. truncated: events after `since` were dropped from the buffer.
  page(since, limit) {
    const has = Number.isFinite(since);
    const after = has ? this.buf.filter(e => e.seq > since) : this.buf;
    const events = has ? after.slice(0, limit) : after.slice(-limit);
    return {
      seq: events.length ? events[events.length - 1].seq : this.seq,
      more: has && after.length > events.length,
      truncated: has && since < this.dropped,
      events,
    };
  }

  reset() { this.dropped = this.seq; this.buf = []; }

  subscribe(req, res, lastId) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    if (Number.isFinite(lastId)) for (const ev of this.buf) if (ev.seq > lastId) this.send(res, ev);
    this.clients.add(res);
    const drop = () => this.clients.delete(res);
    req.on('close', drop);
    res.on('error', drop);
  }

  send(res, ev) {
    try {
      if (res.writableLength > MAX_SSE_BACKLOG) { this.clients.delete(res); res.destroy(); return; }
      res.write(`id: ${ev.seq}\nevent: ${ev.kind}\ndata: ${JSON.stringify(ev)}\n\n`);
    } catch (err) {
      this.clients.delete(res);
      console.error('[pisak] sse write:', err && err.message);
    }
  }

  ping() {
    for (const c of this.clients) {
      try { c.write(': ping\n\n'); } catch (err) { this.clients.delete(c); console.error('[pisak] sse ping:', err && err.message); }
    }
  }
}

class Metrics {
  constructor() { this.reset(); }

  reset() {
    this.since = Date.now();
    this.samples = [];
    this.routed = 0;
    this.errors = { UNKNOWN_NODE: 0, UNKNOWN_APP: 0, NO_LISTENER: 0, TIMEOUT: 0, NODE_UNAVAILABLE: 0, PEER_OVERLOADED: 0,
      MESSAGE_TOO_LARGE: 0, REJECTED: 0, BAD_PROTOCOL: 0 };
    this.retries = 0;
    this.rateLimited = 0;
    this.badRequests = 0;
    this.detections = [];
  }

  record(latencyMs, code) {
    this.routed++;
    if (code && code in this.errors) this.errors[code]++;
    this.samples.push({ ts: Date.now(), latencyMs, code: code || null });
    if (this.samples.length > MAX_SAMPLES) this.samples.splice(0, this.samples.length - MAX_SAMPLES);
  }

  detected(ms) {
    this.detections.push(ms);
    if (this.detections.length > 100) this.detections.shift();
  }

  summary() {
    const now = Date.now();
    let i = 0;
    while (i < this.samples.length && now - this.samples[i].ts > WINDOW_MS) i++;
    if (i) this.samples.splice(0, i);
    const s = this.samples;
    const ok = s.filter(x => !x.code).map(x => x.latencyMs).sort((a, b) => a - b);
    const spanMs = Math.max(1000, Math.min(WINDOW_MS, now - this.since));
    const d = this.detections;
    return {
      p50Ms: percentile(ok, 0.5),
      p95Ms: percentile(ok, 0.95),
      throughputPerSec: round(ok.length * 1000 / spanMs, 1),
      errorRate: s.length ? round((s.length - ok.length) / s.length, 4) : 0,
      detectMs: d.length ? d[d.length - 1] : null,
    };
  }

  full() {
    const d = this.detections;
    return {
      windowMs: WINDOW_MS,
      routed: this.routed,
      ...this.summary(),
      errors: { ...this.errors },
      retries: this.retries,
      rateLimited: this.rateLimited,
      badRequests: this.badRequests,
      detectMsAvg: d.length ? Math.round(d.reduce((a, b) => a + b, 0) / d.length) : null,
    };
  }
}

module.exports = { Events, Metrics, percentile };
