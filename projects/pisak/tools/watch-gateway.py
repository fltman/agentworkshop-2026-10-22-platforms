#!/usr/bin/env python3
"""GET-only watcher for the pisak gateway during a demo or dry run.

  python3 watch-gateway.py [baseUrl] [seconds]
  baseUrl defaults to https://platforms.torget.bjarby.com, seconds to 1200.

Prints one line when the gateway's state or metrics change, one line per non-traffic event, and RESTART when the
board process restarted: the routes counter only goes down on a process start (an admin reset clears events and
metrics but not routes), so a deploy mid-run is told apart from a gateway fault. On exit (time up, Ctrl-C or
SIGTERM) it prints one SUMMARY line, ready to post in #build. It never POSTs.
"""
import json, signal, sys, time, urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else 'https://platforms.torget.bjarby.com').rstrip('/') + '/t/pisak/api'
END = time.time() + float(sys.argv[2] if len(sys.argv) > 2 else 1200)
QUIET = {'route', 'message', 'probe'}


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=5) as r:
        return json.load(r)


def out(line):
    print(f"{time.strftime('%H:%M:%S')} {line}", flush=True)


class Summary:
    """Peaks and totals over the run. Gateway counters restart at an admin reset or a process restart, so each
    stretch between two such drops is a segment, and totals add up the last value of every segment."""

    def __init__(self):
        self.start = time.strftime('%H:%M')
        self.peak = {'nodes': 0, 'p95': 0}
        self.routed = self.segment_routed = 0
        self.errors, self.segment_errors = {}, {}
        self.failovers = 0
        self.last_failover_ms = None
        self.restarts = self.node_downs = self.polls_failed = 0
        self.detect = []

    def close_segment(self):
        self.routed += self.segment_routed
        for k, v in self.segment_errors.items():
            self.errors[k] = self.errors.get(k, 0) + v
        self.segment_routed, self.segment_errors = 0, {}

    def sample(self, nodes, m, ha):
        if m['routed'] < self.segment_routed:
            self.close_segment()
        self.segment_routed = m['routed']
        self.segment_errors = {k: v for k, v in m.get('errors', {}).items() if v}
        self.peak['nodes'] = max(self.peak['nodes'], nodes)
        self.peak['p95'] = max(self.peak['p95'], m.get('p95Ms') or 0)
        if ha:
            self.failovers = max(self.failovers, ha.get('failovers') or 0)
            if ha.get('lastFailoverMs') is not None:
                self.last_failover_ms = ha['lastFailoverMs']

    def event(self, ev):
        kind = ev.get('kind') or ev.get('type')
        if kind == 'node-down':
            self.node_downs += 1
            if ev.get('detectMs') is not None:
                self.detect.append(ev['detectMs'])

    def line(self):
        self.close_segment()
        detect = f"{min(self.detect)}-{max(self.detect)} ms" if self.detect else 'none'
        failover = f"{self.failovers} (last {self.last_failover_ms} ms)" if self.failovers else '0'
        return (f"SUMMARY {self.start}-{time.strftime('%H:%M')}: peak {self.peak['nodes']} nodes, {self.routed} routed, "
                f"peak p95 {self.peak['p95']} ms, errors {json.dumps(self.errors) if self.errors else 'none'}, "
                f"node-down {self.node_downs} (gateway detect {detect}), HA failovers {failover}, "
                f"board restarts {self.restarts}, failed polls {self.polls_failed}")


summary = Summary()


def finish(*_):
    out(summary.line())
    sys.exit(0)


signal.signal(signal.SIGTERM, finish)
seq, routes, last = None, None, None
try:
    while time.time() < END:
        try:
            s, m = get('/state'), get('/metrics')
            ha = s.get('ha') or {}
            if routes is not None and s.get('routes', 0) < routes:
                out(f"RESTART board process restarted (routes {routes} -> {s.get('routes')})")
                summary.restarts += 1
                seq = 0
            routes = s.get('routes', 0)
            nodes = sum(i.get('nodes', 0) for i in ha.get('instances', []) if i.get('role') == 'active') if ha else len(s.get('nodes', []))
            summary.sample(nodes, m, ha)
            errors = {k: v for k, v in m.get('errors', {}).items() if v}
            snap = (f"gw={s['gateway']['status']} nodes={nodes} ha={ha.get('enabled')} active={ha.get('active')} "
                    f"failovers={ha.get('failovers')} routed={m['routed']} p95={m['p95Ms']} err={m['errorRate']} "
                    f"detectMs={m['detectMs']} retries={m['retries']} rateLimited={m['rateLimited']} errors={json.dumps(errors)}")
            if snap != last:
                out('STATE ' + snap)
                last = snap
            if seq is None:
                seq = get('/events?since=0&limit=1').get('seq', 0)
            while True:
                e = get(f'/events?since={seq}&limit=200')
                if e.get('seq', 0) < seq:
                    out(f"CLEARED event seq went back from {seq} to {e.get('seq')} (admin reset, or the restart above)")
                    seq = 0
                    continue
                for ev in e.get('events', []):
                    if (ev.get('kind') or ev.get('type')) not in QUIET:
                        out('EVENT ' + json.dumps(ev)[:300])
                        summary.event(ev)
                seq = e.get('seq', seq)
                if not e.get('more'):
                    break
        except Exception as x:
            summary.polls_failed += 1
            out(f'ERR {x}')
        time.sleep(2)
except KeyboardInterrupt:
    pass
finish()
