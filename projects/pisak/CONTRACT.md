# Gateway contract (module B, team pisak)

Status: **DRAFT v0.2**. Comments and change requests go to `@pisak` in `#build`. Only pisak changes this file, and
every change is announced in `#build` before it ships.

The gateway is the central hub in **gateway mode**: nodes connect only to it, and it handles registration, discovery,
routing, token authentication, timeouts, retries, a circuit breaker, rate limiting and failure detection. In mesh mode
it is idle.

- **Base URL:** `/t/pisak/api` on the board origin (a board plugin, `board/plugins/pisak/`).
- **Transport:** HTTP/JSON, UTF-8. Every body is `Content-Type: application/json`.
- **Time:** timestamps are epoch milliseconds (numbers). Durations are milliseconds.
- **Consumers:** Node (farzad), Control (platforms-tp), Dashboard (anders).

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
  "messageId": "m-7f3a9c",
  "type": "request",
  "source": { "nodeId": "n1", "appId": "echo" },
  "destination": { "nodeId": "n4", "appId": "echo" },
  "timestamp": 1792915200123,
  "correlationId": "m-7f3a9c",
  "payload": { "any": "json" },
  "ttlMs": 2000
}
```

- `type`: `request` | `response` | `oneway` | `broadcast`.
- Broadcast: `destination.nodeId` is `"*"`. The message goes to every registered node that has `destination.appId`,
  except the sender.
- `correlationId`: a response carries the request's `messageId`.
- `ttlMs`: the total time the gateway may spend on the message, retries included.

## 2. Error format and codes

These are the same as farzad's section 2. One field is added: `reason`, which says why a 503 or a `REJECTED`
happened.

```json
{ "error": { "code": "UNKNOWN_NODE", "message": "n9 is not registered", "reason": null }, "correlationId": "m-7f3a9c" }
```

| code               | HTTP      | when                                                                                   |
|--------------------|-----------|----------------------------------------------------------------------------------------|
| `UNKNOWN_NODE`     | 404       | the destination nodeId is not registered                                               |
| `UNKNOWN_APP`      | 404       | the node is registered but does not have that appId                                    |
| `TIMEOUT`          | 504       | no answer within `ttlMs`, retries included                                             |
| `NODE_UNAVAILABLE` | 503       | `reason` is `"node_down"` (failed probes), `"circuit_open"`, or `"gateway_down"` (the gateway is killed) |
| `REJECTED`         | 401 / 429 | `reason` is `"auth"` (401: missing token, bad token, or a token that is not the sender's) or `"rate_limit"` (429, with a `Retry-After` header) |
| `BAD_REQUEST`      | 400       | malformed envelope or body. This is not a protocol code: it means a client bug         |

The gateway passes errors returned by the destination node through to the sender unchanged.

## 3. Node-facing API

All calls except `register` need `Authorization: Bearer <token>`.

### POST `/register`

A node joins. Registering an existing `nodeId` again replaces its entry (new token, new app list), so a restarted node
can rejoin.

Request:

```json
{ "nodeId": "n1", "apps": ["echo", "sink"], "deliverUrl": "/t/farzad/n/n1/deliver",
  "heartbeatUrl": "/t/farzad/n/n1/heartbeat" }
```

Response, `200`:

```json
{ "token": "gw-tok-3c9e...", "probeIntervalMs": 1000, "probeTimeoutMs": 3000 }
```

- `deliverUrl`: where the gateway POSTs messages for this node (section 4). A path on the same origin, or a full URL.
- `heartbeatUrl`: optional. If it is missing and `deliverUrl` ends in `/deliver`, the gateway uses the same URL ending
  in `/heartbeat`.

### POST `/deregister`

Body `{ "nodeId": "n1" }`. Answer `200 { "ok": true }`. The node leaves cleanly.

### POST `/heartbeat` (optional)

Body `{ "nodeId": "n1" }`. Answer `200 { "ok": true }`. A node may push heartbeats instead of being probed. Either
one counts as a sign of life.

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
| `broadcast` | fans out to every matching node in parallel            | `202 { "accepted": true, "messageId": "...", "delivered": 4, "failed": [ { "nodeId": "n3", "code": "TIMEOUT" } ] }` |
| `response`  | not used: a response travels back in the HTTP answer to the request | `400 BAD_REQUEST`                            |

## 4. Gateway to node delivery (farzad section 3)

The gateway calls `POST <deliverUrl>` with the envelope as the body. It adds these headers:

- `X-NodeLink-Gateway: pisak`;
- `X-NodeLink-Attempt: 1`, incremented on every retry. Nodes may drop duplicates by `messageId`.

The node answers as in farzad section 3: `200` with the response envelope for a `request`, `202` for a `oneway` or
`broadcast`, or an error body.

## 5. Failure detection: the gateway probes the nodes

Every `probeIntervalMs` (default 1000) the gateway sends `POST <heartbeatUrl>` with the body
`{ "from": "gateway", "ts": <now> }`, using farzad's heartbeat format.

- A node that answers no probe and sends no `/heartbeat` for `probeTimeoutMs` (default 3000) is marked `down`.
- Messages to a `down` node then fail fast with `503 NODE_UNAVAILABLE` and `reason: "node_down"`.
- The gateway emits a `node-down` event with `detectMs`, the time since the node was last seen alive.
- The next successful probe marks the node `up` again.

**@farzad:** your contract says the heartbeat endpoint is mesh only. Can it also answer probes from `"gateway"` while
in gateway mode? A killed node must not answer. If not, your nodes would need to POST `/heartbeat` to us instead.

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
  "nodes": [
    { "nodeId": "n1", "apps": ["echo", "sink"], "status": "up", "circuit": "closed",
      "lastSeen": 1792915200123, "p50Ms": 3 }
  ],
  "links": [ { "from": "n1", "to": "gateway", "status": "up" } ],
  "connections": 5,
  "metrics": { "p50Ms": 4, "p95Ms": 18, "throughputPerSec": 25.3, "errorRate": 0.0066, "detectMs": 3012 }
}
```

- `status`: `up` | `slow` | `down`.
- `circuit`: `closed` | `open` | `half-open`.
- `links`: one link per registered node, to `gateway`, the same as farzad's gateway-mode links.
- `connections`: the number of nodes that are not `down`. Each holds one connection, to the gateway.

### GET `/metrics`

This is a superset of `state.metrics`:

```json
{
  "windowMs": 60000,
  "routed": 1520, "throughputPerSec": 25.3,
  "p50Ms": 4, "p95Ms": 18,
  "errorRate": 0.0066,
  "errors": { "UNKNOWN_NODE": 0, "UNKNOWN_APP": 0, "TIMEOUT": 3, "NODE_UNAVAILABLE": 7, "REJECTED": 0 },
  "retries": 12, "rateLimited": 0,
  "detectMs": 3012, "detectMsAvg": 3005
}
```

- Latency is measured from receiving `/route` to the answer leaving the gateway. It covers the last 60 seconds.
- `detectMs` is the most recent detection.

### GET `/events?since=<seq>&limit=<n>`

Answers `{ "seq": <latest seq>, "events": [...] }`: the events after `since`, oldest first, 200 at most. The gateway
keeps the last 2000 in a ring buffer.

### GET `/events/stream`

The same events as Server-Sent Events: `id: <seq>`, `event: <kind>`, `data: <json>`. The stream honours
`Last-Event-ID`.

Every event has this shape:

```json
{ "seq": 42, "id": 42, "ts": 1792915200123, "kind": "message", "mode": "gateway",
  "from": "n1", "to": "n4", "ok": true, "latencyMs": 5, "errorCode": null,
  "messageId": "m-7f3a9c", "type": "request", "appId": "echo", "attempts": 1 }
```

`seq` only ever increases. `from`, `to`, `ok`, `latencyMs` and `errorCode` are `null` when they don't apply. Kinds:

- `message` (under heavy traffic it may be sampled, and then `sampled: true` says so)
- `node-registered`, `node-deregistered`
- `node-up`, `node-down` (with `detectMs`), `node-slow`
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
| `reset`  | –                              | clears nodes, metrics and events (between demo runs)                      |

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

{"messageId":"m-1","type":"request","source":{"nodeId":"n1","appId":"echo"},
 "destination":{"nodeId":"n2","appId":"echo"},"timestamp":1792915200000,"correlationId":"m-1",
 "payload":{"hello":1},"ttlMs":2000}
```

The gateway calls `POST /t/farzad/n/n2/deliver` with the same envelope. n2 answers, and n1 gets back `200` with:

```json
{"messageId":"m-2","type":"response","source":{"nodeId":"n2","appId":"echo"},
 "destination":{"nodeId":"n1","appId":"echo"},"timestamp":1792915200004,"correlationId":"m-1",
 "payload":{"hello":1}}
```

## Open questions

1. **@farzad:** can your heartbeat endpoint answer gateway probes in gateway mode (section 5)? And does
   `heartbeatUrl`, or deriving it from `deliverUrl`, work for you?
2. **@platforms-tp:** do you call `POST /t/pisak/api/admin` `{ "action": "kill" }` and `revive` for your
   kill-gateway action? Do you want `reset` before each gateway run?
