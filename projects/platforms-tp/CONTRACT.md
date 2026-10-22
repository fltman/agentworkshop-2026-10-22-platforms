# Control module contract

The platforms-tp team owns the control-plane and scenario orchestration module for the NodeLink demo.

## Module responsibility

- start and stop simulated nodes
- configure message traffic and payload mix
- trigger chaos faults (kill node, slow node, drop messages, kill gateway)
- measure latency, throughput, error rate and connection count
- expose scenario events for the dashboard and other teams

## HTTP API

### GET /t/platforms-tp/api/state
Returns the current scenario state as JSON.

The state includes `source` (`live` or `simulation`) and `liveError`. When Farzad is available, displayed metrics and
node count are read from its live `/api/state`; local simulated metrics are used only as a fallback and the tile
labels that fallback. `scenario.results.mesh` and `.gateway` retain Farzad's whole-run `metrics.lastRun` values,
including `durationMs`, `openConnections`, and a stable `capturedAt`; missing detection metrics remain `null`.
The separate `scenario.detection` values are measured from each node-kill request until Farzad reports that node
down. `scenario.baseline` records the five-node mesh stage before scaling, and `scenario.eventCursors` records the
Farzad event sequence range collected for each demo step.

Example response:

```json
{
  "mode": "mesh",
  "source": "live",
  "liveError": null,
  "running": false,
  "nodeCount": 5,
  "traffic": {
    "rate": 120,
    "payloadBytes": 256,
    "mix": { "request": 60, "oneway": 33, "broadcast": 7 }
  },
  "gateway": {
    "healthy": true,
    "available": true,
    "haEnabled": false,
    "ha": null,
    "timeoutMs": 1200,
    "retries": 3
  },
  "metrics": {
    "throughput": 118,
    "latencyP50": 22,
    "latencyP95": 49,
    "errorRate": 0.02,
    "openConnections": 10,
    "failedNodeDetectionMs": 1500
  },
  "chaos": {
    "nodeKilled": null,
    "slowNode": null,
    "dropRate": 0
  },
  "scenario": {
    "name": "baseline",
    "step": "ready",
    "runId": null,
    "results": { "mesh": null, "gateway": null },
    "baseline": null,
    "detection": { "mesh": null, "gateway": null },
    "eventCursors": {}
  }
}
```

### POST /t/platforms-tp/api/control
Accepts JSON with an `action` string and optional fields.

Supported actions:

- `toggle-mode` — switch between `mesh` and `gateway`
- `set-traffic` — set `rate`, `payloadBytes`, `dropRate`
- `start-scenario` — run the demo scenario
- `kill-node` — set `nodeId` to fail a specific node
- `slow-node` — set `nodeId` and `latencyMs`
- `drop-messages` — set `dropRate`
- `toggle-gateway` — kill or recover the gateway
- `toggle-ha` — enable or disable HA mode
- `reset` — restore default values

`start-scenario` returns immediately with `running: true`; poll `/api/state` for step progress and completion. It
resets the gateway and NodeLink to five mesh nodes, measures a five-node traffic baseline, scales to fifteen, and
measures traffic and node-failure detection in mesh mode. It then switches to gateway mode, restores the failed node,
and repeats the same traffic and node-failure steps. The mode comparison uses Farzad's `metrics.lastRun.mesh` and
`.gateway` fields; event timing reports kill-to-node-down detection separately. Optional Pisak metrics are only
shown as gateway-hop/HA diagnostics. When Pisak exposes its additive HA state, the runner also checks
single-gateway failure/recovery, enables HA, kills the active instance, verifies failover, restores the standby, and
disables HA. Older gateway versions skip only this optional HA stretch. The runner stops traffic and leaves the
system in gateway mode, avoiding a new mesh run that would replace the frozen mesh comparison. Other controls return
`409` while the demo is running. A failed live step
pauses the demo, attempts to stop traffic and restore gateway availability, reports the error in
`scenario.step`/`liveError`, and unlocks controls.

`toggle-ha` forwards the desired enabled state to Pisak's HA admin action, using its current detection interval or
1000 ms when no HA state is available.

Node controls use fixed Farzad API paths for state, reset, scaling, mode, traffic, chaos and events; gateway controls
use Pisak's state and admin APIs. Requests go over loopback without following redirects. `toggle-gateway` sends
`kill` or `revive`; `reset` sends `reset`, which clears gateway state without reviving a killed gateway. Switching
from mesh to gateway sends gateway `reset` first and returns `503` if the gateway remains down. If an upstream API
is unavailable, redirects, or returns invalid JSON, the control request fails rather than claiming the live action
succeeded.

Example request:

```json
{
  "action": "set-traffic",
  "rate": 180,
  "payloadBytes": 512,
  "dropRate": 5
}
```

Traffic mixes use `request`, `oneway`, and `broadcast` send types. Setting traffic does not change chaos state.
Message-drop chaos targets a healthy node and changes only its drop percentage, without clearing other node faults.

## Event stream

The module exposes a compact summary and event history at:

- `GET /t/platforms-tp/status`
- `GET /t/platforms-tp/api/events`

The event stream returns the most recent scenario, mode, traffic, and fault messages, with timestamps.
On board mention, the module replies with a short status summary for the current scenario.
