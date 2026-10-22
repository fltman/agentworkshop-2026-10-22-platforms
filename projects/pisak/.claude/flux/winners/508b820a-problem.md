---
problem-hash: 508b820a
started: 2026-10-22 10:13
status: active
context: prototyping
secondary-contexts: [performance, security-critical (auth only)]
timelines: [α, β, γ]
---

# Problem: NodeLink Gateway (module B)

Build the central gateway for NodeLink, a node-to-node messaging protocol over HTTP/JSON (see `PROJEKT.md` in the
repo root). In gateway mode the nodes connect only to the gateway, which handles:

- registry and discovery;
- routing of request/response, one-way and broadcast messages;
- token-based node authentication;
- timeouts, retries and a per-node circuit breaker;
- per-node rate limiting;
- heartbeat failure detection (time to detect is a dashboard metric);
- a kill/revive chaos hook for Control;
- state, metrics and an event stream for the Dashboard;
- an HA pair (stretch goal).

## Interface (fixed)

`projects/pisak/CONTRACT.md` (DRAFT v0.1, already posted in `#build`). Every timeline must honour it. Timelines differ
in **internal architecture**, not in the contract. A timeline that wants a contract change proposes it, and pisak
announces it in `#build` before shipping.

## Constraints

- Runs as a board plugin: `board/plugins/pisak/index.js`, mounted at `/t/pisak/`. Plain Node, no npm dependencies.
- It shares one process with every other team's plugin:
  - nothing may throw from a timer or a promise (`try/catch` inside every callback, `.catch()` on every promise);
  - unref every timer;
  - no `while(true)`;
  - no posting on a timer.
- Board text shown in any tile is escaped (`textContent`, never `innerHTML`).
- Scale: 3 to 20 nodes, configurable traffic, a live 5-minute demo. The time budget is a workshop day, so a working
  demo beats a perfect design.
- Consumers are farzad (Node), platforms-tp (Control) and anders (Dashboard). We test against their real modules,
  not mocks, as soon as they exist.

## Context detection

```
Signals:
  ✓ "workshop day", "live demo", "stretch"          → prototyping (PRIMARY)
  ✓ "latency p50/p95", "throughput", "rate limit"   → performance
  ✓ "token auth"                                    → security-critical (narrow: demo-grade auth)
  ✓ "shared process, must never throw"              → defensive is REQUIRED regardless of context

PRIMARY CONTEXT: prototyping

Graveyard filters (graveyard empty, so these come from the gene profiles):
  ✓ experimental, bold, aggressive → allowed, but subject to the safety-gene rules
  ⚠ cautious > 0.5                 → LIMIT (-18% in prototyping)
  ⚠ analytical > 0.8               → LIMIT (over-analysis)
  ☠ defensive < 0.4                → BLOCKED for this problem (one uncaught throw takes down every team's plugin)
```

## Fitness weights

These are the prototyping weights, with errors weighted up because of the shared process:

| weight     | value | why                                                        |
|------------|-------|------------------------------------------------------------|
| completion | 1.5   | a working demo matters most                                |
| tests      | 0.8   | tests guard the contract, not a coverage goal              |
| runs       | 1.0   |                                                            |
| elegance   | 0.4   |                                                            |
| user       | 1.0   | feedback from farzad, platforms-tp and anders counts as user signal |
| tokens     | 0.8   |                                                            |
| steps      | 0.5   |                                                            |
| errors     | 1.5   | a crash affects the whole board                            |

## Concrete fitness criteria (normalized 0 to 100)

| criterion                | points | how it is measured                                                                       |
|--------------------------|--------|------------------------------------------------------------------------------------------|
| Contract conformance     | 25     | a scripted test hits every endpoint in `CONTRACT.md`; status codes and body shapes match |
| Chaos survival           | 20     | kill a node, slow a node, drop 30%, kill/revive the gateway: correct error codes, breaker opens and closes, no hang beyond `timeoutMs * (retries+1)` |
| Process safety           | 15     | grep for unguarded `setTimeout`/`setInterval`/promises; a fuzz test with bad JSON and huge bodies does not throw |
| Overhead                 | 10     | gateway-added p50 latency is under 5 ms at 20 nodes × 50 msg/s on localhost              |
| Observability            | 10     | `/state`, `/metrics` and `/events/stream` give what the dashboard needs, including failure detection ms |
| Demo readiness           | 10     | the PROJEKT.md demo script steps 5 and 6 work end to end against farzad's real nodes     |
| Clarity / size           | 10     | one reviewer can read it in 10 minutes; no dead code; no stubs                           |
| HA (bonus)               | +10    | kill instance a, traffic continues through b without node re-registration               |

Gaming flags apply (see `flux-core.md`). In particular, a contract test that only checks HTTP 200 gets the
`LOW_COVERAGE_PASS` penalty.
