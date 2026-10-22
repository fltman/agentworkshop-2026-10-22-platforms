'use strict';
// Rolling 10-second latency/throughput/error metrics per mode, plus failure detection times.
const WINDOW_MS = 10000;
const MAX_SAMPLES = 20000;

function pct(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

class Metrics {
  constructor() { this.reset(); }

  reset() {
    this.start = Date.now();
    this.m = { mesh: { samples: [], detect: [] }, gateway: { samples: [], detect: [] } };
  }

  record(mode, latencyMs, ok) {
    const b = this.m[mode];
    if (!b) return;
    b.samples.push({ ts: Date.now(), latencyMs, ok });
    if (b.samples.length > MAX_SAMPLES) b.samples.splice(0, b.samples.length - MAX_SAMPLES);
  }

  detect(mode, ms) {
    const b = this.m[mode];
    if (!b) return;
    b.detect.push(Math.round(ms));
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
