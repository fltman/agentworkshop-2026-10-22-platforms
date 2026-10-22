# Gateway contract (module B, team pisak)

Status: **v0.3, implemented** in `board/plugins/pisak/` (tests: `projects/pisak/test/gateway.test.mjs`). Comments and
change requests go to `@pisak` in `#build`. Only pisak changes this file, and every change is announced in `#build`
before it ships.

The gateway is the central hub in **gateway mode**: nodes connect only to it, and it handles registration, discovery,
routing, token authentication, timeouts, retries, a circuit breaker, rate limiting and failure detection. In mesh mode
it is idle.

- **Base URL:** `/t/pisak/api` on the board origin (a board plugin, `board/plugins/pisak/`).
- **Transport:** HTTP/JSON, UTF-8. Every body is `Content-Type: application/json`.
- **Time:** timestamps are epoch milliseconds (numbers). Durations are milliseconds.
- **Consumers:** Node (farzad), Control (platforms-tp), Dashboard (anders).

## Changes from v0.2

These align the gateway with farzad's Node contract v0.2. They were announced in `#build`.

- **Envelope:** the gateway accepts `proto`, `version`, `scope`, `listenerId` and `msgTypeId`.
  - If `proto` is present it must be `"nodelink"`; if `version` is present it must be `2`.
  - `destination.appId` may be `"*"`.
  - Listener ids are checked by the node, not the gateway.
- **Errors:**
  - An invalid envelope or body is `400 BAD_PROTOCOL` (was `BAD_REQUEST`).
  - An envelope over 65536 bytes is `413 MESSAGE_TOO_LARGE`.
  - Every error the gateway makes has `at: "gateway"`.
  - Node errors, including `NO_LISTENER` and `PEER_OVERLOADED`, pass through unchanged.
- **Breaking, broadcast:** `delivered` is a list of node ids (was a count). The broadcast respects `scope`, and
  `cluster`, the default, leaves out external nodes.
- **Register:**
  - `apps` may be `["echo"]` or `[{"appId": "echo", "listenerIds": []}]`.
  - `external: true` marks a node outside the cluster.
  - `deliverUrl` and `heartbeatUrl` must be same-origin `/t/...` team paths. Full URLs are refused.
- **Heartbeat and probes:**
  - The heartbeat body may name the node with `nodeId` or `from`.
  - `state: "restarting"` gives 10 s of grace. `"leaving"` is not a failure.
  - Probes send `{from, seq, ts, state}` and read `state` from the answer.
- **State:** adds `routes`, `possibleLinks`, `openConnections`, `maxMessageBytes`, `nodes[].external` and `links[].state`
  (`reachable` | `unreachable` | `restarting` | `disabled`). Node `status` adds `restarting` and `leaving`.
- **Metrics:** the window is 10 s, the same as farzad's (was 60 s). `errors` has a key for every protocol code.
- **Events:** `/events` adds `more` and `truncated`. Event fields are unchanged: `kind` stays.

## Changes from v0.1

These changes align the contract with farzad's Node contract v0.1 (`projects/farzad/CONTRACT.md`) and anders'
requests in `#build`.

- `register` takes `apps` (was `appIds`). `appIds` is still accepted as an alias.
- The error code is `UNKNOWN_APP` (was `UNKNOWN_APPLICATION`).
- The error body is `{error:{code,message,reason?}, correlationId}`.
- `REJECTED` answers 401 or 429 only. A token that does not match the sender is now a 401, not a 403.
- The timeout comes from the envelope's `ttlMs` (default 2000). The `X-NodeLink-Timeout` header is gone.
- Failure detection: the gateway **probes** each node's heartbeat endpoint itself. Nodes do not have to send
  heartbeats to us. **Needs farzad's OK**: see section 5.
- Events take a common shape: `seq` (and `id`, the same number, only increasing), `ts`, `kind`, `mode`, `from`, `to`,
  `ok`, `latencyMs`, `errorCode`. The polling answer is `{seq, events}`, the same as farzad's.
- `/state` has per-node `status` (`up` | `slow` | `down`), `circuit` and `links`. Metric names are `p50Ms`, `p95Ms`,
  `throughputPerSec`, `errorRate` and `detectMs`, the same as farzad's.

## 1. Message envelope

**Owned by farzad.** It is mirrored here for reference only; `projects/farzad/CONTRACT.md` section 1 wins if the two
differ.

```json
{
  "proto": "nodelink",
  "version": 2,
  "messageId": "n1-1042",
  "type": "request",
  "source": { "nodeId": "n1", "appId": "echo", "listenerId": null },
  "destination": { "nodeId": "n4", "appId": "echo", "listenerId": null },
  "scope": "cluster",
  "timestamp": 1792915200123,
  "correlationId": "n1-1042",
  "payload": { "any": "json" },
  "ttlMs": 2000
}
```

- `type`: `request` | `response` | `oneway` | `broadcast`.
- Broadcast: `destination.nodeId` is `"*"`, and `listenerId` must be `null`. The message goes to every registered node
  that has `destination.appId` (or to every node, for `"*"`), except the sender. Nodes registered as `external` are
  only included with `scope: "all"`.
- `correlationId`: a response carries the request's `messageId`.
- `ttlMs`: the total time the gateway may spend on the message, retries included.
- Size: at most 65536 bytes of JSON, otherwise `413 MESSAGE_TOO_LARGE`.

## 2. Error format and codes

These are the same as farzad's section 2. `reason` says why a 503 or a `REJECTED` happened, and `at` is `"gateway"`
for every error the gateway makes itself.

```json
{ "error": { "code": "UNKNOWN_NODE", "reason": null, "at": "gateway", "message": "n9 is not registered" }, "correlationId": "n1-1042" }
```

| code                | HTTP      | when                                                                                   |
|---------------------|-----------|----------------------------------------------------------------------------------------|
| `UNKNOWN_NODE`      | 404       | the destination nodeId is not registered                                               |
| `UNKNOWN_APP`       | 404       | the node is registered but does not have that appId                                    |
| `TIMEOUT`           | 504       | no answer within `ttlMs`, retries included                                             |
| `NODE_UNAVAILABLE`  | 503       | `reason` is `"node_down"` (failed probes), `"circuit_open"`, `"unreachable"`, `"bad_response"` (the node answered without a NodeLink error), or `"gateway_down"` (the gateway is killed) |
| `REJECTED`          | 401 / 429 | `reason` is `"auth"` (401: missing token, bad token, or a token that is not the sender's) or `"rate_limit"` (429, with a `Retry-After` header) |
| `MESSAGE_TOO_LARGE` | 413       | the envelope is larger than 65536 bytes                                                |
| `BAD_PROTOCOL`      | 400       | invalid envelope or body, wrong `proto`, or unsupported `version`                       |

The gateway passes errors returned by the destination node through to the sender unchanged, for example
`NO_LISTENER`, `PEER_OVERLOADED` or the node's own `TIMEOUT`.

## 3. Node-facing API

All calls except `register` need `Authorization: Bearer <token>`.

### POST `/register`

A node joins. Registering an existing `nodeId` again replaces its entry (new token, new app list), so a restarted node
can rejoin.

Request:

```json
{ "nodeId": "n1", "apps": [{ "appId": "echo", "listenerIds": [] }, "sink"], "deliverUrl": "/t/farzad/n/n1/deliver",
  "heartbeatUrl": "/t/farzad/n/n1/heartbeat", "external": false }
```

Response, `200`:

```json
{ "token": "gw-tok-3c9e...", "probeIntervalMs": 1000, "probeTimeoutMs": 3000 }
```

- `apps`: app ids, or `{appId, listenerIds}` objects. Register again to change them.
- `deliverUrl`: where the gateway POSTs messages for this node (section 4). It must be a path on the same origin under
  `/t/<team>/`, without `.`/`..` segments or `%`. Full URLs and the gateway's own `/t/pisak/` paths are refused, so
  the gateway cannot be pointed at other hosts or at the board's API.
- `heartbeatUrl`: optional, with the same rules. If it is missing and `deliverUrl` ends in `/deliver`, the gateway uses
  the same URL ending in `/heartbeat`.
- `external`: optional, default `false`. An external node only gets broadcasts sent with `scope: "all"`.

### POST `/deregister`

Body `{ "nodeId": "n1" }`. Answer `200 { "ok": true }`. The node leaves cleanly.

### POST `/heartbeat` (optional)

Body `{ "nodeId": "n1" }` or farzad's `{ "from": "n1", "seq": 17, "ts": ..., "state": "up" }`. Answer
`200 { "ok": true }`. A node may push heartbeats as well as being probed. Either one counts as a sign of life.
`state: "restarting"` gives the node 10 s of grace without a `node-down`; `"leaving"` marks it `leaving`, which is not
a failure; `"up"` ends both.

### GET `/nodes`

Discovery. Lists every registered node:

```json
{ "nodes": [ { "nodeId": "n1", "apps": ["echo", "sink"], "status": "up" } ] }
```

### POST `/route`

The body is one envelope (section 1). The token must belong to `source.nodeId`.

| type        | what the gateway does                                  | answer                                                    |
|-------------|--------------------------------------------------------|-----------------------------------------------------------|
| `request`   | delivers it and waits for the response                 | `200` with the response envelope, or an error             |
| `oneway`    | delivers it, retrying if needed                        | `202 { "accepted": true, "messageId": "..." }`, or an error |
| `broadcast` | fans out to every matching node in `scope` in parallel | `202 { "accepted": true, "messageId": "...", "delivered": ["n2", "n4"], "failed": [ { "nodeId": "n3", "code": "TIMEOUT" } ] }` |
| `response`  | not used: a response travels back in the HTTP answer to the request | `400 BAD_PROTOCOL`                           |

## 4. Gateway to node delivery (farzad section 3)

The gateway calls `POST <deliverUrl>` with the envelope as the body. It adds these headers:

- `X-NodeLink-Gateway: pisak`;
- `X-NodeLink-Attempt: 1`, incremented on every retry. Nodes may drop duplicates by `messageId`.

The node answers as in farzad section 3: `200` with the response envelope for a `request`, `202` for a `oneway` or
`broadcast`, or an error body.

## 5. Failure detection: the gateway probes the nodes

Every `probeIntervalMs` (default 1000) the gateway sends `POST <heartbeatUrl>` with the body
`{ "from": "gateway", "seq": <n>, "ts": <now>, "state": "up" }`, using farzad's heartbeat format. farzad agreed in
`#build` that nodes answer these probes in every mode, and that a killed node stays silent.

- A node that answers no probe and sends no `/heartbeat` for `probeTimeoutMs` (default 3000) is marked `down`, unless
  it said it is `restarting` (10 s grace) or `leaving`.
- Messages to a `down` node then fail fast with `503 NODE_UNAVAILABLE` and `reason: "node_down"`.
- The gateway emits a `node-down` event with `detectMs`, the time since the node was last seen alive.
- The next successful probe marks the node `up` again. A `state` in the probe answer is applied as for `/heartbeat`.

## 6. Resilience defaults

All of these can be changed at runtime with `config` (section 7).

| setting           | default | meaning                                                                         |
|-------------------|---------|---------------------------------------------------------------------------------|
| `defaultTtlMs`    | 2000    | used when the envelope has no `ttlMs`                                           |
| `retries`         | 2       | extra attempts after a network error or a 503, with backoff (100 ms, then 200 ms), all inside `ttlMs` |
| `breakerFailures` | 5       | consecutive failures to a node before its circuit **opens**                     |
| `breakerOpenMs`   | 5000    | time in open state before one **half-open** trial message                       |
| `rateLimitPerSec` | 50      | token bucket per source node                                                    |
| `rateLimitBurst`  | 100     | bucket size                                                                     |
| `probeIntervalMs` | 1000    | how often the gateway probes each node                                          |
| `probeTimeoutMs`  | 3000    | how long a node can be silent before it is marked `down`                        |
| `slowThresholdMs` | 500     | a node whose p50 delivery latency over its last 20 messages is above this is `slow` |

## 7. Control and observability API (for Control and Dashboard)

### GET `/state`

```json
{
  "gateway": { "id": "a", "status": "up", "startedAt": 1792915200000 },
  "config": { "defaultTtlMs": 2000, "retries": 2 },
  "maxMessageBytes": 65536,
  "routes": 1834,
  "nodes": [
    { "nodeId": "n1", "apps": ["echo", "sink"], "external": false, "status": "up", "circuit": "closed",
      "lastSeen": 1792915200123, "p50Ms": 3, "inFlight": 0 }
  ],
  "links": [ { "from": "n1", "to": "gateway", "status": "up", "state": "reachable" } ],
  "possibleLinks": 5,
  "openConnections": 5,
  "connections": 5,
  "metrics": { "p50Ms": 4, "p95Ms": 18, "throughputPerSec": 25.3, "errorRate": 0.0066, "detectMs": 3012 }
}
```

- `status`: `up` | `slow` | `down` | `restarting` | `leaving`.
- `routes`: authenticated `/route` calls since the gateway process started. Admin `reset` does not clear it, so a
  client can compare it before and after a test to prove its traffic went through the gateway.
- `circuit`: `closed` | `open` | `half-open`.
- `links`: one link per registered node, to `gateway`, the same as farzad's gateway-mode links. `state` uses farzad's
  link states: `reachable` (up or slow), `unreachable` (down, or the gateway is killed), `restarting`, `disabled`
  (leaving).
- `possibleLinks`: one per registered node. `openConnections`: the links that are `reachable`.
- `connections`: the number of nodes that are not `down`. Kept for v0.2 readers.

### GET `/metrics`

This is a superset of `state.metrics`:

```json
{
  "windowMs": 10000,
  "routed": 1520, "throughputPerSec": 25.3,
  "p50Ms": 4, "p95Ms": 18,
  "errorRate": 0.0066,
  "errors": { "UNKNOWN_NODE": 0, "UNKNOWN_APP": 0, "NO_LISTENER": 0, "TIMEOUT": 3, "NODE_UNAVAILABLE": 7,
              "PEER_OVERLOADED": 0, "MESSAGE_TOO_LARGE": 0, "REJECTED": 0, "BAD_PROTOCOL": 0 },
  "retries": 12, "rateLimited": 0, "badRequests": 0,
  "detectMs": 3012, "detectMsAvg": 3005
}
```

- Latency is measured from receiving `/route` to the answer leaving the gateway. It covers the last 10 seconds, the
  same window as farzad's metrics.
- `routed` and `errors` count since the last `reset`. `badRequests` counts envelopes the gateway refused itself
  (`BAD_PROTOCOL`, `MESSAGE_TOO_LARGE`); they are not routed messages.
- `detectMs` is the most recent detection.

### GET `/events?since=<seq>&limit=<n>`

Answers `{ "seq": <n>, "more": false, "truncated": false, "events": [...] }`: the events after `since`, oldest first,
`limit` (at most 200) at most. Without `since`, the latest `limit` events. The gateway keeps the last 2000.

- `seq` is the seq of the last event returned. Use it as the next `since`.
- `more`: more events are already waiting. Call again right away.
- `truncated`: events after `since` were already dropped (buffer overflow or `reset`).

### GET `/events/stream`

The same events as Server-Sent Events: `id: <seq>`, `event: <kind>`, `data: <json>`. Because each event is named,
listen with `addEventListener('<kind>', ...)` (for example `message`, `node-down`); `onmessage` alone only sees
`message` events. The stream honours `Last-Event-ID` (or `?since=<seq>`) and sends `: ping` every 15 s.

Every event has this shape:

```json
{ "seq": 42, "id": 42, "ts": 1792915200123, "kind": "message", "mode": "gateway",
  "from": "n1", "to": "n4", "ok": true, "latencyMs": 5, "errorCode": null,
  "messageId": "n1-1042", "type": "request", "appId": "echo", "attempts": 1 }
```

`seq` only ever increases, also across `reset`. `from`, `to`, `ok`, `latencyMs` and `errorCode` are `null` when they
don't apply. In a `message` event, `type` is the message type (`request`, `oneway`, `broadcast`); a broadcast adds
`delivered` and `failedCount` (counts) and `scope`. Kinds:

- `message` (under heavy traffic it may be sampled, and then `sampled: true` says so)
- `node-registered` (with `external`), `node-deregistered`
- `node-up`, `node-down` (with `detectMs`), `node-slow`, `node-restarting`, `node-leaving`
- `circuit-open`, `circuit-half-open`, `circuit-closed` (`to` is the node)
- `rate-limited` (`from` is the node)
- `gateway-killed`, `gateway-revived`, `config-changed`

### POST `/admin`

Chaos and configuration, for Control. The body is `{ "action": "<action>", ... }`:

| action   | body                           | effect                                                                    |
|----------|--------------------------------|---------------------------------------------------------------------------|
| `kill`   | –                              | the gateway goes `down`: every node-facing call answers `503 NODE_UNAVAILABLE` with `reason: "gateway_down"` |
| `revive` | –                              | the gateway is `up` again. Registrations are lost, so nodes must register again |
| `config` | `{ "config": { ...partial } }` | changes the settings in section 6                                         |
| `reset`  | –                              | clears nodes, metrics and events (between demo runs). It does **not** revive a killed gateway |

Answer: `200 { "ok": true, "state": <same as GET /state> }`. `GET /state`, `/metrics` and `/events` keep answering
while the gateway is killed, so the dashboard can show it.

## 8. Mode switching

farzad owns the mode (`POST /t/farzad/api/mode`).

- On entering gateway mode, farzad's nodes `register`.
- On leaving gateway mode, they `deregister`.
- Control may call our `reset` before a gateway run, so it starts from zero metrics.

## 9. Stretch: HA pair

There are two instances, `a` and `b`, at `/t/pisak/gw/a/api` and `/t/pisak/gw/b/api`. Each has the API above.
`/t/pisak/api` is an alias for the currently active instance.

- The two instances share their registry, so a failover keeps registrations and tokens.
- Nodes that get `503` with `reason: "gateway_down"` retry against the other instance.
- `kill` and `revive` take `{ "instance": "a" | "b" }`.

This is to be confirmed with farzad before we build it.

## 10. Example: one request in gateway mode

The node sends this to the gateway:

```http
POST /t/pisak/api/route
Authorization: Bearer gw-tok-3c9e
Content-Type: application/json

{"proto":"nodelink","version":2,"messageId":"n1-1","type":"request","source":{"nodeId":"n1","appId":"echo","listenerId":null},
 "destination":{"nodeId":"n2","appId":"echo","listenerId":null},"timestamp":1792915200000,"correlationId":"n1-1",
 "payload":{"hello":1},"ttlMs":2000}
```

The gateway calls `POST /t/farzad/n/n2/deliver` with the same envelope. n2 answers, and n1 gets back `200` with:

```json
{"proto":"nodelink","version":2,"messageId":"n2-1","type":"response","source":{"nodeId":"n2","appId":"echo","listenerId":null},
 "destination":{"nodeId":"n1","appId":"echo","listenerId":null},"timestamp":1792915200004,"correlationId":"n1-1",
 "payload":{"hello":1}}
```

## Open questions

1. **@platforms-tp:** wire your kill-gateway action to `POST /t/pisak/api/admin` `{ "action": "kill" }` and
   `revive`, and call `reset` before each gateway run (agreed in `#build`, waiting for your runner).
2. **@farzad:** confirm the v0.3 changes (broadcast `delivered` as a list, `BAD_PROTOCOL`, register `apps` objects and
   `external`), and test against the live gateway once your nodes are merged.

## Tests

`node --test projects/pisak/test/gateway.test.mjs` from the repo root. It starts a board server with this plugin and
a fake node plugin (`projects/pisak/test/fakenodes/`, shaped like farzad's nodes) and covers every section above.
