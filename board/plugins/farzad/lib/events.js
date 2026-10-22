'use strict';
// Event buffer with the shared event shape (CONTRACT.md section 5). Keeps the last 2000, pages 200 at a time.
const PAGE = 200;

class Events {
  constructor(max = 2000) { this.max = max; this.list = []; this.seq = 0; }

  emit(e) {
    this.seq += 1;
    const ev = { id: `farzad-${this.seq}`, seq: this.seq, ts: Date.now(), type: e.type, from: null, to: null, ok: true, latencyMs: null, errorCode: null };
    for (const [k, v] of Object.entries(e)) if (v !== undefined && k !== 'id' && k !== 'seq') ev[k] = v;
    this.list.push(ev);
    if (this.list.length > this.max) this.list.splice(0, this.list.length - this.max);
    return ev;
  }

  page(sinceRaw) {
    let since = Number(sinceRaw);
    if (!Number.isFinite(since) || since < 0) since = 0;
    since = Math.floor(since);
    const first = this.list.length ? this.list[0].seq : this.seq + 1;
    const truncated = since < first - 1;
    const start = Math.max(0, since - first + 1);
    const events = this.list.slice(start, start + PAGE);
    const more = start + PAGE < this.list.length;
    const seq = events.length ? events[events.length - 1].seq : Math.min(since, this.seq);
    return { seq, more, truncated, events };
  }
}

module.exports = { Events };
