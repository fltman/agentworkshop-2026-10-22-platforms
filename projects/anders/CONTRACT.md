# Contract: anders, module D (Dashboard)

Owner: team `anders`. Only we change this file; we announce changes in `#build` first.

## What we offer

A static web app (HTML/JS/CSS, no build step, no npm dependencies):

| What | Where |
| --- | --- |
| Dashboard UI | `/colony/anders/` (files in `board/public/colony/anders/`) |
| Optional thin backend (CORS-free proxy, scenario helpers) | `/t/anders/` (`board/plugins/anders/index.js`) |

The dashboard is read/control only. It owns no simulation state. It offers no API to other teams.

## What we show

- Live topology: nodes, connections, animated message flow.
- Per mode (mesh, gateway): latency p50/p95, throughput, error rate, open connections, time to detect a failed node.
- Controls: mode switch, node count (3-20), traffic (msg/s, type mix, payload size), chaos (kill node, slow node, drop %, kill gateway), scenario start.
- Side-by-side mesh vs gateway comparison under the same scenario.

## What we use

The dashboard reads state and events directly from Node and Gateway, and sends all controls through Control.

### Node (`farzad`), per projects/farzad/CONTRACT.md v0.1

- `GET /t/farzad/api/state`: `mode`, `nodes[{nodeId, apps, status, chaos}]`, `links[{from, to, status}]`, `connections`, `metrics.{mesh,gateway}.{p50Ms, p95Ms, throughputPerSec, errorRate, detectMs}`.
- `GET /t/farzad/api/events?since=<seq>`: `{seq, events[{seq, ts, kind, mode, messageId, type, from, to, latencyMs, error}]}`. Kinds: message, node-up, node-down, mode-change, chaos.

### Gateway (`pisak`), per their draft v0.1 (contract lands with their first PR)

- `GET /t/pisak/api/state`, `GET /t/pisak/api/metrics` (p50/p95, throughput, error rate, failure detection ms).
- `GET /t/pisak/api/events?since=<id>` and `GET /t/pisak/api/events/stream` (SSE).
- We asked pisak for: per-node status, per-node circuit state, a monotonic event id.

### Control (`platforms-tp`), per projects/platforms-tp/CONTRACT.md

- `POST /t/platforms-tp/api/control` with `{ "action": "...", ...params }`. Actions: toggle-mode, set-traffic, start-scenario, kill-node, slow-node, drop-messages, toggle-gateway.
- `GET /t/platforms-tp/api/state` for scenario status and anything Control aggregates.
- Control is the only way the dashboard changes the system. If Control lacks an action we need, we ask in `#build`.

### How we merge it

- Poll the `state` endpoints about every 1 s, and events with `since` (or SSE for pisak).
- Normalize events in the client to one shape: `{ id, ts, kind, mode, from, to, ok, latencyMs, errorCode }`. The common event shape was proposed in `#build`; until the owners agree, we map each team's fields ourselves.
- Mesh view and metrics come from farzad's `metrics.mesh`; gateway view and metrics from pisak's metrics, falling back to farzad's `metrics.gateway`.
- Missing fields are shown as "n/a"; the dashboard must never crash on a partial or failing response, and shows which source is down.

## Example

Dashboard sends:

```
POST /t/platforms-tp/api/control
{ "action": "kill-node", "nodeId": "n3" }
```

Expected: `200` with the new state (or `{ "ok": true }`); the next `state` poll shows `n3` as `down`.

## Open questions for `#build`

- @platforms-tp: confirm the action parameter names, and whether Control exposes anything the dashboard should read beyond Node and Gateway state.
- @pisak: per-node circuit state and a monotonic event id in `/state` and `/events`.
- Dashboard owns the start script and the one-artefact deploy (PROJEKT.md); we will say in `#build` what it needs from the others.
