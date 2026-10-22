# Gateway contract (module B, team pisak)

Status: **v0.7, implemented** in `board/plugins/pisak/` (tests: `projects/pisak/test/gateway.test.mjs`). Comments and
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
  - Probes send `{from, seq, ts, state, peers}` and read `state` from the answer.
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

## Changes in v0.7 (farzad's audit, #build 294)

- A re-register keeps the token when it carries the current token, or repeats the same `deliverUrl` within 3 s
  (section 3, `/register`). Concurrent registers from one node no longer leave it with a stale token.
- A route to a node the gateway knew before a restart, which has not registered again yet, answers
  `503 NODE_UNAVAILABLE` with `reason: "not_registered"` instead of `404 UNKNOWN_NODE`. A node that deregistered, or
  any node after `reset`, is still `UNKNOWN_NODE`.
- `/metrics` `detectMs` stays `null` until the gateway has detected a node down since the last `reset`. It is
  measured from the node's last successful probe to the moment it is declared down. The agreed demo figure (kill to
  node-down) comes from farzad's `lastRun`.

## Changes in v0.6 (HA pair, demo step 6)

- Additive, off by default: an HA pair of gateway instances behind the same base URL (section 9). With HA off,
  nothing changes: `kill` takes the gateway down and nodes register again after `revive`.
- New admin action `ha` (`{ "enabled": true, "detectMs": 1000 }`). `kill` and `revive` take an optional `instance`.
- `/state` gains an `ha` block. New events: `gateway-failover`, `ha-enabled`, `ha-disabled`.
- `gateway.id` in `/state` is the active instance (`a` or `b`) and may change on a failover.

## Changes in v0.5 (requested by farzad)

- Additive: every probe body carries `peers`, the gateway's view of every **other** registered node and its status
  (`up` | `slow` | `down` | `restarting` | `leaving`), for example `{"n2":"up","n3":"down"}`. Nodes use it to keep
  per-peer state in gateway mode. A node that does not know the field can ignore it.

## Changes in v0.4 (review by farzad)

- The gateway never follows redirects, for deliveries or for probes. A node that answers 3xx gets `503
  NODE_UNAVAILABLE` with `reason: "bad_response"` (not retried), and a 3xx heartbeat answer is a failed probe.
- `ttlMs` has a floor of 50 ms.
- A `TIMEOUT` caused by a sender's short `ttlMs` (below `defaultTtlMs`) does not count toward the receiver's circuit
  breaker and is not used for its `slow` status.

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
- `ttlMs`: the total time the gateway may spend on the message, retries included. Values below 50 are raised to 50,
  values above 60000 are lowered to 60000.
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
| `NODE_UNAVAILABLE`  | 503       | `reason` is `"node_down"` (failed probes), `"circuit_open"`, `"unreachable"`, `"bad_response"` (the node answered without a NodeLink error, or with a redirect: the gateway never follows a 3xx), `"not_registered"` (the gateway knew the node before it restarted, and the node has not registered again yet), or `"gateway_down"` (the gateway is killed) |
| `REJECTED`          | 401 / 429 | `reason` is `"auth"` (401: missing token, bad token, or a token that is not the sender's) or `"rate_limit"` (429, with a `Retry-After` header) |
| `MESSAGE_TOO_LARGE` | 413       | the envelope is larger than 65536 bytes                                                |
| `BAD_PROTOCOL`      | 400       | invalid envelope or body, wrong `proto`, or unsupported `version`                       |

The gateway passes errors returned by the destination node through to the sender unchanged, for example
`NO_LISTENER`, `PEER_OVERLOADED` or the node's own `TIMEOUT`.

## 3. Node-facing API

All calls except `register` need `Authorization: Bearer <token>`.

### POST `/register`

A node joins. Registering an existing `nodeId` again replaces its entry (new app list, fresh state), so a restarted
node can rejoin. The token is kept when the request carries the node's current token as `Authorization: Bearer
<token>`, or when the same `deliverUrl` registers again within 3 s of the last registration (two registers in
flight from one node get one token). Otherwise a new token is issued and the old one stops working.

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
`{ "from": "gateway", "seq": <n>, "ts": <now>, "state": "up", "peers": { "n2": "up", "n3": "down" } }`, using farzad's
heartbeat format plus `peers` (v0.5: every other registered node with its `/state` status, never the node itself). farzad agreed in
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
| `breakerFailures` | 5       | consecutive failures to a node before its circuit **opens**. A `TIMEOUT` only counts when the sender's `ttlMs` was at least `defaultTtlMs`: a short sender budget is not the node's fault |
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
- `gateway-failover` (`from` / `to` are instance ids, plus `failoverMs` and `nodes`), `ha-enabled` (with
  `detectMs`), `ha-disabled` (section 9)

### POST `/admin`

Chaos and configuration, for Control. The body is `{ "action": "<action>", ... }`:

| action   | body                           | effect                                                                    |
|----------|--------------------------------|---------------------------------------------------------------------------|
| `kill`   | `{ "instance"?: "a" \| "b" }`   | the gateway (default: the active instance) goes `down`: every node-facing call answers `503 NODE_UNAVAILABLE` with `reason: "gateway_down"` |
| `revive` | `{ "instance"?: "a" \| "b" }`   | the gateway (default: the active instance, and the standby too when HA is on) is `up` again. Without HA, registrations are lost, so nodes must register again |
| `config` | `{ "config": { ...partial } }` | changes the settings in section 6                                         |
| `reset`  | –                              | clears nodes, metrics and events (between demo runs). It does **not** revive a killed gateway, and it keeps the HA setting |
| `ha`     | `{ "enabled": bool, "detectMs"?: 100..10000 }` | turns the HA pair on or off (section 9)                    |

Answer: `200 { "ok": true, "state": <same as GET /state> }`. `GET /state`, `/metrics` and `/events` keep answering
while the gateway is killed, so the dashboard can show it.

## 8. Mode switching

farzad owns the mode (`POST /t/farzad/api/mode`).

- On entering gateway mode, farzad's nodes `register`.
- On leaving gateway mode, they `deregister`.
- Control may call our `reset` before a gateway run, so it starts from zero metrics.

## 9. Stretch: HA pair (v0.6)

There are two gateway instances, `a` and `b`, in an active/standby pair behind the **same** base URL
`/t/pisak/api`. Nodes need no change: they keep one URL and one token.

- **Off by default.** Only `a` runs, and `b` is `off`. A `kill` takes the gateway down until `revive`.
- **Turn it on:** `POST /admin {"action":"ha","enabled":true,"detectMs":1000}`. The standby starts and receives a
  copy of the active registry (nodes, apps, delivery URLs and tokens) every 250 ms. If the active is already dead,
  the standby takes over at once with an empty registry (this is not counted as a failover).
- **Failover:** when the active is killed, node-facing calls answer `503 gateway_down` until `detectMs` has passed.
  Then the standby becomes active with the replicated registry: the same tokens work, and nobody registers again.
  Every `register` and `deregister` is also written through to the standby at once, so a token handed out just
  before the kill still works after the failover.
- **Not replicated:** circuit breakers, rate-limit buckets, in-flight requests and latency samples. The new active
  starts them fresh and probes every node itself. Events and metrics are shared, so the dashboard sees one stream.
- **Fail back:** `revive` brings the dead instance back as the standby, resynced from the active.
  `kill {"instance":"b"}` then fails over again. Killing the standby only removes the protection.
- **Turn it off:** `{"action":"ha","enabled":false}` stops the standby. If the active was dead, the running standby
  stays on as the only instance.

`/state` (and every admin answer) carries:

```json
"ha": { "enabled": true, "active": "b", "detectMs": 1000, "failovers": 1, "lastFailoverMs": 1012,
        "lastFailoverAt": 1792915260000,
        "instances": [ { "id": "a", "status": "down", "role": "standby", "nodes": 0 },
                       { "id": "b", "status": "up", "role": "active", "nodes": 4 } ] }
```

`role` is `active` | `standby` | `off`. For the demo (step 6): run gateway mode, `kill`, and the dashboard shows
every node unreachable. Then `revive`, `ha` on, and `kill` again: after about `detectMs` traffic flows again, and
`lastFailoverMs` is the number to compare with the time a mesh needs to detect the same failure.

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
