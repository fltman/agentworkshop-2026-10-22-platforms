'use strict';
// Rolling 10-second latency/throughput/error metrics per mode, plus failure detection times.
// Also one run per mode: aggregates over the whole time spent in that mode, frozen when the mode is left.
const WINDOW_MS = 10000;
const MAX_SAMPLES = 20000;
const RESERVOIR = 2000;
const { bump } = require('./node');

function pct(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

class Metrics {
  constructor() { this.reset(); }

  reset() {
    this.start = Date.now();
    this.m = { mesh: { samples: [], detect: [] }, gateway: { samples: [], detect: [] } };
    this.runs = { mesh: null, gateway: null };
  }

  // A new run of a mode replaces that mode's previous run.
  startRun(mode, now = Date.now()) {
    if (!(mode in this.runs)) return;
    this.runs[mode] = { startedTs: now, endedTs: null, topo: null, messages: 0, errors: 0, lat: [], detectSum: 0, detectCount: 0, failures: {} };
  }

  // Freezes the run, with the topology it had when the mode was left.
  endRun(mode, topo, now = Date.now()) {
    const r = this.runs[mode];
    if (!r || r.endedTs !== null) return;
    r.endedTs = now;
    r.topo = topo;
  }

  runView(mode, liveTopo, now = Date.now()) {
    const r = this.runs[mode];
    if (!r) return null;
    const end = r.endedTs === null ? now : r.endedTs;
    const t = r.topo || liveTopo;
    const lat = [...r.lat].sort((x, y) => x - y);
    const durationMs = end - r.startedTs;
    return {
      startedTs: r.startedTs, endedTs: r.endedTs, durationMs,
      nodes: t.nodes, openConnections: t.openConnections, possibleLinks: t.possibleLinks,
      messages: r.messages,
      p50Ms: pct(lat, 0.5), p95Ms: pct(lat, 0.95),
      throughputPerSec: Math.round((r.messages / Math.max(1, durationMs / 1000)) * 10) / 10,
      errorRate: r.messages ? Math.round((r.errors / r.messages) * 1000) / 1000 : 0,
      detectMsAvg: r.detectCount ? Math.round(r.detectSum / r.detectCount) : null,
      failures: { ...r.failures },
    };
  }

  record(mode, latencyMs, ok, errorCode) {
    const b = this.m[mode];
    if (!b) return;
    const r = this.runs[mode];
    if (r && r.endedTs === null) {
      r.messages += 1;
      // Reservoir sample: every message has the same chance to be in the percentile sample.
      if (r.lat.length < RESERVOIR) r.lat.push(latencyMs);
      else { const j = Math.floor(Math.random() * r.messages); if (j < RESERVOIR) r.lat[j] = latencyMs; }
      if (!ok) { r.errors += 1; bump(r.failures, errorCode || 'UNKNOWN'); }
    }
    b.samples.push({ ts: Date.now(), latencyMs, ok });
    if (b.samples.length > MAX_SAMPLES) b.samples.splice(0, b.samples.length - MAX_SAMPLES);
  }

  detect(mode, ms) {
    const b = this.m[mode];
    if (!b) return;
    b.detect.push(Math.round(ms));
    const r = this.runs[mode];
    if (r && r.endedTs === null) { r.detectSum += Math.round(ms); r.detectCount += 1; }
    if (b.detect.length > 1000) b.detect.shift();
  }

  snapshot(mode) {
    const b = this.m[mode];
    const now = Date.now();
    const cut = now - WINDOW_MS;
    let i = 0;
    while (i < b.samples.length && b.samples[i].ts < cut) i += 1;
    if (i) b.samples.splice(0, i);
    const lat = b.samples.map((s) => s.latencyMs).sort((x, y) => x - y);
    const errors = b.samples.filter((s) => !s.ok).length;
    const windowSec = Math.max(1000, Math.min(WINDOW_MS, now - this.start)) / 1000;
    const det = b.detect;
    return {
      p50Ms: pct(lat, 0.5),
      p95Ms: pct(lat, 0.95),
      throughputPerSec: Math.round((b.samples.length / windowSec) * 10) / 10,
      errorRate: b.samples.length ? Math.round((errors / b.samples.length) * 1000) / 1000 : 0,
      detectMs: det.length ? det[det.length - 1] : null,
      detectMsAvg: det.length ? Math.round(det.reduce((a, x) => a + x, 0) / det.length) : null,
    };
  }
}

module.exports = { Metrics };
