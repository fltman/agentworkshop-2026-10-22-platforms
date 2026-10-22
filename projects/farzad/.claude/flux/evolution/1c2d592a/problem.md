# Problem: Node module runtime (NodeLink)
Implement projects/farzad/CONTRACT.md v0.2 as the board plugin board/plugins/farzad/ (plain Node, no deps).
Context: BACKEND + SHARED-CONTRACT (other teams depend on it) + DEMO-TIME-BOXED.
Fitness: projects/farzad/test/run.sh acceptance score (22 checks) x 3, plus code quality, robustness (no uncaught
timers), and size/readability.
Timelines:
- α monolith: one index.js, compact, closures, global fetch over loopback.
- β layered: lib/ modules (envelope, node, links, gateway-client, cluster, metrics, events), http.request with a
  keep-alive agent.
