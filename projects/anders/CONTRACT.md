# Contract: anders, module D (Dashboard)

Owner: team `anders`. Only we change this file; we announce changes in `#build` first.

## What we offer

A static web app (HTML/JS/CSS, no build step, no npm dependencies):

| What | Where |
| --- | --- |
| Dashboard UI | `/colony/anders/` (files in `board/public/colony/anders/`) |

The dashboard is read/control only. It owns no simulation state. It offers no API to other teams.

## What we show

- Live topology: nodes, connections, animated message flow.
- Per mode (mesh, gateway): latency p50/p95, throughput, error rate, open connections, time to detect a failed node.
- Controls: mode switch, node count (3-20), traffic (msg/s, type mix, payload size), chaos (kill, revive, slow, drop %, clear, kill/revive gateway). Scripted demo scenario: later.
- Side-by-side mesh vs gateway comparison under the same scenario.

## What we use

The dashboard is a static page (`index.html`, `app.js`, `sim.js`, `style.css`). It reads state and events from Node
and Gateway, and sends controls straight to their control endpoints.

### Node (`farzad`), per projects/farzad/CONTRACT.md v0.2

Read, every 1 s and every 0.5 s:

- `GET /t/farzad/api/state`: `mode`, `switching`, `nodes[{nodeId, status, messaging, chaos}]`,
  `links[{from, to, state}]`, `possibleLinks`, `openConnections`,
  `metrics.{mesh,gateway}.{p50Ms, p95Ms, throughputPerSec, errorRate, detectMs}`.
- `GET /t/farzad/api/events?since=<seq>`: `{seq, more, events}`. We page while `more` is true. The first batch is
  read only to learn `seq`, so old events are not animated.

Controls:

| Button | Call |
| --- | --- |
| Mesh / Gateway | `POST /t/farzad/api/mode {"mode"}` |
| Reset cluster | `POST /t/farzad/api/reset {"nodes", "mode"}` |
| Add node / Remove selected | `POST /t/farzad/api/nodes {"count": 1, "external": false}` / `DELETE /t/farzad/api/nodes/<id>` |
| Traffic Apply / Stop | `POST /t/farzad/api/traffic {"rate", "mix": {request, oneway, broadcast}, "payloadBytes"}` / `{"rate": 0}` |
| Kill, Revive, Slow 800 ms, Drop 30%, Clear | `POST /t/farzad/api/chaos {"action", "nodeId", "delayMs" or "percent"}` |

### Gateway (`pisak`), per projects/pisak/CONTRACT.md v0.2 (PR #4)

- `GET /t/pisak/api/state`: `gateway.status`, `nodes[{nodeId, status, circuit}]`, `metrics`.
- `GET /t/pisak/api/metrics`: preferred source for the gateway column.
- `GET /t/pisak/api/events?since=<seq>`: circuit, node and gateway events for the log.
- Kill gateway / Revive gateway: `POST /t/pisak/api/admin {"action": "kill" | "revive"}`.

### Control (`platforms-tp`)

Only checked for liveness (`GET /t/platforms-tp/api/state`) for now. Their API is simulation-only today
(`#build` 35, 37). When it drives the real nodes, we can add a scenario runner panel on top of it.

### How we merge it

- Events from both teams are normalized to `{ id, ts, type, from, to, ok, latencyMs, errorCode, mode }`. farzad's
  `type` (`message.request`, `node.down`) is used as is. pisak's `kind` becomes the type: `message` + `type` gives
  `message.request`, `node-down` gives `node.down`.
- Message events animate on the topology. In gateway mode both teams report each message, so only farzad's are
  animated, and pisak's only when farzad is down. Other events go to the event log.
- Mesh column: farzad `metrics.mesh`. Gateway column: pisak `/metrics`, then pisak `state.metrics`, then farzad
  `metrics.gateway`. A mode with no traffic in the window shows "n/a", not 0.
- Open connections: farzad's `openConnections / possibleLinks`, remembered per mode.
- Missing fields show "n/a". A failing source shows as "down" in the header and never breaks the page.

### Demo mode

While farzad's `/state` fails twice in a row, the dashboard runs `sim.js`, an in-browser simulator with the same
shapes, and shows **DEMO DATA**. It switches back to live data by itself as soon as farzad answers.

## Example

Dashboard sends:

```
POST /t/farzad/api/chaos
{ "action": "kill", "nodeId": "n3" }
```

Expected: `200`. The next `state` shows `n3` as `down`, `openConnections` drops, and a `node.down` event with
`detectMs` appears in the log.

## Open questions for `#build`

- @platforms-tp: when your control drives real nodes, do you want the dashboard to call your scenario runner
  instead of farzad and pisak directly?
- PROJEKT.md says the dashboard owns the start script and the one-artefact deploy. Today everything runs as board
  plugins plus our colony tile, so no start script is needed. Say in `#build` if anyone needs one.
