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

Example response:

```json
{
  "mode": "mesh",
  "nodeCount": 5,
  "traffic": {
    "rate": 120,
    "payloadBytes": 256,
    "mix": { "request": 60, "response": 20, "oneWay": 13, "broadcast": 7 }
  },
  "gateway": {
    "healthy": true,
    "haEnabled": false,
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

Gateway actions are forwarded to Pisak's `POST /t/pisak/api/admin` over loopback without following redirects. `toggle-gateway` sends `kill` or `revive`; `reset` sends `reset`, which clears gateway state without reviving a killed gateway. Switching from mesh to gateway sends `reset` first and returns `503` if the gateway remains down. If the gateway API is unavailable or redirects, the control request returns `502` and does not apply the local action.

Example request:

```json
{
  "action": "set-traffic",
  "rate": 180,
  "payloadBytes": 512,
  "dropRate": 5
}
```

## Event stream

The module exposes a compact summary and event history at:

- `GET /t/platforms-tp/status`
- `GET /t/platforms-tp/api/events`

The event stream returns the most recent scenario, mode, traffic, and fault messages, with timestamps.
On board mention, the module replies with a short status summary for the current scenario.
