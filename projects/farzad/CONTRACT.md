# NodeLink Node module: contract (team farzad)

Owner: team `farzad`. Version: `0.2` (draft). Changes are announced in `#build` before they ship. What changed since
0.1 is listed at the end, followed by the additive changes made after 0.2.

Nodes are virtual nodes running inside the board plugin `board/plugins/farzad/`. Every call between nodes, and between
nodes and the gateway, is a real HTTP/JSON call. Base URL: `/t/farzad/` on the group's board.

## 1. Message envelope

Every message, in both modes, is this JSON object:

```json
{
  "proto": "nodelink",
  "version": 2,
  "messageId": "n1-1042",
  "type": "request",
  "msgTypeId": 1,
  "source":      { "nodeId": "n1", "appId": "echo", "listenerId": null },
  "destination": { "nodeId": "n4", "appId": "echo", "listenerId": null },
  "scope": "cluster",
  "timestamp": 1792915200123,
  "correlationId": "n1-1042",
  "ttlMs": 2000,
  "payload": { "any": "json" }
}
```

| Field | Type | Notes |
|---|---|---|
| `proto` | `"nodelink"` | Sanity marker. Anything else is rejected with `BAD_PROTOCOL`. |
| `version` | number | Protocol version, `2` for this contract. An unsupported version is rejected with `BAD_PROTOCOL`. |
| `messageId` | string | Unique in the cluster: `<nodeId>-<counter>`. Used for duplicate suppression. |
| `type` | `request` \| `response` \| `oneway` \| `broadcast` | |
| `msgTypeId` | number, optional | Application-defined message type. Each application gives its own types readable names (section 7). |
| `source` | `{nodeId, appId, listenerId}` | Sender. `listenerId` is optional. |
| `destination` | `{nodeId, appId, listenerId}` | See the addressing rules below. |
| `scope` | `cluster` \| `all` | Only when `destination.nodeId` is `"*"`. `cluster` (default) excludes external nodes, `all` includes them. |
| `timestamp` | number | Epoch milliseconds when the message was sent. |
| `correlationId` | string | A `response` carries the `messageId` of its request. Otherwise the same as `messageId`. |
| `ttlMs` | number, optional | End-to-end budget, including any gateway retries. For a request: until the response. For a one-way message or broadcast: until the destination accepted it. Default 2000. |
| `payload` | any JSON | Application parameters. Their shape belongs to the application, which may reject a payload it cannot read with `BAD_PROTOCOL`. |

A `response` has `source` and `destination` swapped compared with its request, and `type: "response"`.

### Addressing

| `nodeId` | `appId` | `listenerId` | Delivered to |
|---|---|---|---|
| `n4` | `echo` | `null` | Application `echo` on node `n4`. |
| `n4` | `echo` | `"7c1e…"` | That one listener instance of `echo` on `n4`. |
| `n4` | `"*"` | `null` | Every application on node `n4`. |
| `"*"` | `echo` | `null` | Application `echo` on every node in `scope`. |
| `"*"` | `"*"` | `null` | Every application on every node in `scope`. |

- An application registers an `appId`, and can register one or more `listenerId`s (UUIDs) so that several instances
  of the same application on one node can be addressed separately.
- `nodeId: "*"` requires `type: "broadcast"`, and `listenerId` must be `null`. A `broadcast` always has
  `nodeId: "*"`. Anything else is `BAD_PROTOCOL`.
- The sender never gets its own broadcast.
- **Fan-out:** in mesh mode the sending node fans out to every cluster peer. In gateway mode the node sends the
  broadcast once to the gateway, and the gateway fans out, leaving out the sender and respecting `scope`.
- **External nodes** are outside the cluster and are always reached through the gateway, in both modes. They have no
  mesh links and no mesh heartbeats. With `scope: "all"` in mesh mode, the sender fans out to its cluster peers
  directly and sends one copy, addressed to the external nodes, through the gateway's route. If the gateway is down,
  the external nodes are listed in `failed` with `NODE_UNAVAILABLE`.

### Size

The serialized envelope (UTF-8 JSON) is at most **65536 bytes**. The limit is checked when sending and on receipt.
Larger messages are rejected with `MESSAGE_TOO_LARGE`.

## 2. Error codes

An error is returned as:

```json
{"error": {"code": "REJECTED", "reason": "rate_limit", "at": "gateway", "message": "text"}, "correlationId": "n1-1042"}
```

The `code` in the body is authoritative. An HTTP status without `error.code` (for example a 404 from the board
itself) is not a protocol error. `at` says who produced the error (`node`, `gateway`, or the node ID).

| Code | HTTP | Meaning |
|---|---|---|
| `UNKNOWN_NODE` | 404 | No node with that ID. |
| `UNKNOWN_APP` | 404 | The node exists but has no application with that ID. |
| `NO_LISTENER` | 404 | The application exists but has no listener with that `listenerId`. |
| `TIMEOUT` | 504 | No answer within `ttlMs`. Also what the sender sees when a message is dropped. |
| `NODE_UNAVAILABLE` | 503 | The node (or, with `at: "gateway"`, the gateway) is known but down. |
| `PEER_OVERLOADED` | 503 | The destination has too many messages in flight (default limit 50 per node). A message counts as in flight from the moment it reaches the node until it is answered, including time held by `slow` chaos. |
| `MESSAGE_TOO_LARGE` | 413 | The envelope is larger than 65536 bytes. |
| `REJECTED` | 401 / 429 | `reason: "auth"` (401) or `reason: "rate_limit"` (429). Only the gateway produces it; a `rate_limit` rejection is passed to the sender unchanged (`at: "gateway"`) and is not retried. |
| `BAD_PROTOCOL` | 400 | Wrong `proto`, unsupported `version`, or an invalid envelope. |
| `MODE_SWITCH_FAILED` | 502 | Only from `POST /api/mode`, see section 4. |
| `MIN_NODES` | 409 | Only from `DELETE /api/nodes/<id>`: the cluster cannot go below 3 nodes. |
| `MAX_NODES` | 409 | Only from `POST /api/nodes`: the cluster cannot go above 20 nodes. |

## 3. Node endpoints (used by peers and by the gateway)

### `POST /t/farzad/n/<nodeId>/deliver`

Delivers one envelope to a node. Used by mesh peers and by the gateway. No token is needed: the gateway and the nodes
run on the same origin.

- `request`: answer `200` with the `response` envelope.
- `oneway`, and one copy of a `broadcast`: answer `202 {"accepted": true}` **after** the application has accepted it.
  A delivery failure is answered right away with an error from section 2, so the sender always learns about it.
- Duplicate suppression: each node keeps the last 256 `messageId`s it received, for at most 60 seconds. The ID is
  reserved on first receipt. A duplicate `request` gets the same response as the first copy: if the first copy is
  still running, the duplicate waits for its result. A duplicate `oneway` gets
  `202 {"accepted": true, "duplicate": true}`. The application sees each message once, and duplicates are not counted
  in the metrics.

### `POST /t/farzad/n/<nodeId>/heartbeat`

Mesh ping, and a health check the gateway may use.

Request: `{"from": "n2", "seq": 17, "ts": 1792915200123, "state": "up"}`.
`state` is `up`, `restarting` (a planned restart is coming) or `leaving` (the node is about to stop cleanly).
The gateway also probes this endpoint every second with `{"from": "gateway", "ts": ...}`; `seq` and `state` are
optional for the gateway. A killed node answers nobody.

Answer `200`: `{"nodeId": "n4", "seq": 17, "receivedTs": 1792915200125, "ts": 1792915200126, "state": "up"}`.

The sender estimates the clock offset from the four timestamps (send, receive, answer, answer received):
`offsetMs = ((receivedTs - sentTs) + (ts - answerReceivedTs)) / 2`. A link is `in` sync when `|offsetMs|` is at most
100 ms, and `out` of sync otherwise.

### Link states (per directed pair in mesh mode, per node-to-gateway link in gateway mode)

```
unreachable ──first answer──▶ initializing ──2 answers in a row──▶ reachable
reachable ──3 missed heartbeats──▶ unreachable          (a failure: counts for detectMs)
reachable ──peer says "restarting"──▶ restarting ──answers again within 10 s──▶ reachable
                                                 └── no answer after 10 s ──▶ unreachable
any ──peer says "leaving", or mode makes the link unused──▶ disabled     (not a failure)
```

Heartbeat interval 1000 ms, 3 misses before `unreachable`, restart grace 10000 ms. They are also shown in
`GET /api/state`.

**Node-to-gateway links** (gateway mode, and external nodes in both modes) have no heartbeat of their own. Such a link
is `initializing` while the node registers, and `reachable` while the latest register or route call to the gateway
succeeded. It becomes `unreachable` when a call to the gateway gets no answer or `NODE_UNAVAILABLE`, and `reachable`
again on the next successful call. It is `disabled` when the node is not registered. The gateway's heartbeat probes
(section 3) also count as successful contact, so an idle link is tracked too.

### Messaging enabled

Each node has `messaging: "enabled" | "disabled"`. A node is `disabled` until it is ready for the current mode: in
mesh mode, until it has one `reachable` link; in gateway mode, until its registration succeeded. This applies when it
starts, is added, is revived, comes back from a restart, and during a mode switch.

A send from a `disabled` node is queued, not rejected. It goes out as soon as the node is enabled, or fails with
`TIMEOUT` when its `ttlMs` runs out first. Each change is emitted as an event (`messaging.enabled`,
`messaging.disabled`), which is how applications are notified.

## 4. Cluster control (used by Control, team platforms-tp)

| Call | Body | Effect |
|---|---|---|
| `POST /t/farzad/api/reset` | `{"nodes": 5, "mode": "mesh"}` | Fresh cluster of 3 to 20 nodes. |
| `POST /t/farzad/api/nodes` | `{"count": 1, "external": false}` | Adds nodes, at most 20 in total, external nodes included. `external: true` adds nodes outside the cluster (only reached with `scope: "all"`, always through the gateway). Answer: the new node IDs. |
| `DELETE /t/farzad/api/nodes/<nodeId>` | | Stops a node cleanly: announces `leaving`, deregisters, then stops. `MIN_NODES` below 3. |
| `POST /t/farzad/api/nodes/<nodeId>/apps` | `{"appId": "billing", "listenerId": null, "msgTypes": {"1": "QUERY"}}` | Registers an application (or a listener instance) on a node. |
| `DELETE /t/farzad/api/nodes/<nodeId>/apps/<appId>` | `?listenerId=<id>` optional | Unregisters it. |
| `POST /t/farzad/api/mode` | `{"mode": "mesh"}` or `{"mode": "gateway"}` | Switches mode at runtime, see below. |
| `POST /t/farzad/api/send` | see below | Makes one node send one message. |
| `GET /t/farzad/api/requests/<requestId>` | | Result of an async request. |
| `DELETE /t/farzad/api/requests/<requestId>` | | Aborts a pending request. No result is recorded after an abort. |
| `POST /t/farzad/api/traffic` | `{"rate": 20, "mix": {"request": 0.6, "oneway": 0.3, "broadcast": 0.1}, "payloadBytes": 256, "includeDown": false}` | Built-in traffic generator. `{"rate": 0}` stops it. Senders are random `up` cluster nodes with messaging enabled. Destinations are the other `up` cluster nodes; with `"includeDown": true` (opt-in, default `false`) they also include `down` and `restarting` nodes, so a kill shows up in the error rate. The answer echoes the settings. |
| `POST /t/farzad/api/chaos` | see below | Fault injection on nodes. |

Every node has the built-in applications `echo` (answers a request with its payload) and `sink` (accepts one-way
messages and broadcasts, no answer).

### Send

```json
{"from": {"nodeId": "n1", "appId": "echo"}, "type": "request",
 "to": {"nodeId": "n3", "appId": "echo", "listenerId": null}, "scope": "cluster",
 "msgTypeId": 1, "payload": {}, "ttlMs": 2000, "userData": {"any": "json"}, "async": false}
```

`userData` is opaque, stays on the sending side, and comes back with the result. The result has an `outcome`:

| `outcome` | When |
|---|---|
| `response` | A request got its response. |
| `timeout` | A request got no answer within `ttlMs`. |
| `failure` | A request failed with an error from section 2. |
| `accepted` | A one-way message was accepted by the destination. |
| `error` | A one-way message could not be delivered. |
| `broadcast` | A broadcast finished; per-node results are in `delivered` and `failed`. |

```json
{"requestId": "r-88", "messageId": "n1-1042", "outcome": "response", "latencyMs": 6,
 "response": { "...": "response envelope" }, "error": null, "userData": {"any": "json"}}

{"requestId": "r-89", "messageId": "n1-1043", "outcome": "broadcast", "latencyMs": 14,
 "delivered": ["n2", "n4"], "failed": [{"nodeId": "n3", "code": "NODE_UNAVAILABLE"}], "userData": null}
```

With `"async": true` the answer is `202 {"requestId": "r-88"}` right away. The result is read with
`GET /api/requests/<requestId>` (`{"outcome": "pending"}` until it is done) and also appears as an event.

### Mode switch

`POST /api/mode {"mode": "gateway"}`:

1. Every node goes `messaging: disabled`. New sends are queued (section 3); messages already in flight finish on
   the old path.
2. Every node with status `up` registers with the gateway, in parallel. Nodes that are `down` are skipped and
   register when they come back.
3. If the gateway accepts the registrations, the switch commits: answer
   `200 {"mode": "gateway", "switchMs": 180, "failed": []}`, and a `mode.change` event with `ok: true`. Each node is
   enabled again as soon as its own registration succeeded. A single node whose registration fails is listed in
   `failed`, stays `disabled` and retries every second. That alone does not fail the switch.
4. If the gateway does not answer or rejects every registration, the switch rolls back: the nodes that did register
   deregister again, the cluster stays in mesh mode, and the answer is `502` with `MODE_SWITCH_FAILED` and
   `"failed": [{"nodeId": "n3", "code": "NODE_UNAVAILABLE"}]`. A `mode.change` event has `ok: false`, and the nodes are
   enabled again on their mesh links.

In gateway mode, any node that becomes `up` later (added, revived, back from a restart) registers first and stays
`disabled` until that succeeded.

Switching back to mesh deregisters every node from the gateway, then rebuilds the mesh links. They start as
`unreachable` and come up through `initializing`, and each node is enabled again when its first link is `reachable`.

### Chaos

```json
{"action": "kill",    "nodeId": "n3"}
{"action": "revive",  "nodeId": "n3"}
{"action": "restart", "nodeId": "n3", "downMs": 3000}
{"action": "slow",    "nodeId": "n3", "delayMs": 800}
{"action": "drop",    "nodeId": "n3", "percent": 30}
{"action": "skew",    "nodeId": "n3", "skewMs": 500}
{"action": "clear",   "nodeId": "n3"}
```

- `kill`: the node stops answering and stops sending heartbeats, with no announcement. It stays in the list as `down`.
- `restart`: a graceful restart. The node announces `restarting`, is down for `downMs`, then comes back. Its status
  is `restarting` from the moment the chaos call answers (the answer already shows it), and it answers nothing until it
  is back.
- `slow` and `drop` apply to everything the node receives, heartbeats included, so they can cause false failure
  detection. That is on purpose. A dropped message gives the sender `TIMEOUT`.
- `skew` shifts the node's clock, to show links going `out` of clock sync.
- Killing the gateway is the Gateway team's hook, not ours. In gateway mode a dead gateway gives
  `NODE_UNAVAILABLE` with `at: "gateway"`.

## 5. State and events (used by Dashboard, team anders, and by Control)

### `GET /t/farzad/api/state`

```json
{
  "mode": "mesh",
  "switching": false,
  "heartbeat": {"intervalMs": 1000, "missesBeforeDown": 3, "restartGraceMs": 10000},
  "maxMessageBytes": 65536,
  "nodes": [
    {"nodeId": "n1", "external": false, "status": "up", "messaging": "enabled", "inflight": 2,
     "apps": [{"appId": "echo", "listenerIds": [], "msgTypes": {}}, {"appId": "sink", "listenerIds": [], "msgTypes": {}}],
     "chaos": {"delayMs": 0, "dropPercent": 0, "skewMs": 0}}
  ],
  "links": [
    {"from": "n1", "to": "n2", "state": "reachable", "clockSync": "in", "offsetMs": 1, "lastHeartbeatTs": 1792915200123}
  ],
  "possibleLinks": 20,
  "openConnections": 20,
  "metrics": {
    "mesh":    {"p50Ms": 4, "p95Ms": 11, "throughputPerSec": 18.5, "errorRate": 0.01, "detectMs": 3100, "detectMsAvg": 3050},
    "gateway": {"p50Ms": 0, "p95Ms": 0, "throughputPerSec": 0, "errorRate": 0, "detectMs": null, "detectMsAvg": null}
  }
}
```

- Node `status`: `up`, `down`, `restarting`, `leaving`.
- `links` in mesh mode: one entry per directed pair. In gateway mode: one link per node, `to: "gateway"`.
- `possibleLinks`: the links the topology needs: n·(n−1) directed links between the n cluster nodes in mesh mode, plus
  one gateway link per external node; one gateway link per node in gateway mode. n counts every node not stopped with
  `DELETE`, so a killed node still counts: it is the gap between `possibleLinks` and `openConnections`.
- `openConnections`: the links that are `reachable` right now. It drops when a node is killed.
- `possiblePairs` and `openPairs` (additive): the same as undirected connections, for drawings with one line per
  pair. In mesh mode, n·(n−1)/2 node pairs, and a pair is open when both directed links are `reachable`. A gateway
  link is already one connection, so it counts once in both. 5 nodes in mesh: 20 links, 10 pairs; in gateway mode: 5
  and 5.
- Latency, throughput and error rate use a rolling 10-second window. `detectMs` is the latest value, `detectMsAvg` the
  average since the last reset.
- `detectMs` has one definition in both modes: the time from the `kill` until our node runtime learns that the node
  is down, both taken on the node module's clock. In mesh mode that is when the first peer marks the node
  `unreachable`. In gateway mode it is when the node module sees the gateway's down report: an event with `kind`
  `node-down` and `to` = the nodeId on `GET /t/pisak/api/events?since=N`, polled every 200 ms while a killed node
  waits for detection. The gateway's own figure (which may start at its last good probe, not at the kill) is not
  used for `detectMs`; it is kept on our `node.down` event as `gatewayDetectMs` (`null` if the gateway gives none).
  `metrics.<mode>.detectMs`, `detectMsAvg` and `lastRun.<mode>.detectMsAvg` all use this definition. Before a
  switch to gateway mode the node module calls `POST /t/pisak/api/admin {"action": "reset"}`. Planned leaves and
  restarts are not counted.

#### Node internals (additive, v0.2 compatible)

Extra fields; nothing above is renamed or removed. All counters start at 0 on `POST /api/reset` and for new nodes.

```json
"nodes": [{"nodeId": "n1", "...": "fields above",
  "limits": {"inflight": 50}, "queued": 0, "pending": 1,
  "dedup": {"size": 42, "hits": 2},
  "gateway": {"registered": false, "lastProbeAgeMs": null},
  "counters": {"sent":     {"request": 12, "response": 9, "oneway": 3, "broadcast": 1},
               "received": {"request": 9, "response": 11, "oneway": 2, "broadcast": 0},
               "failures": {"NO_LISTENER": 1}}}],
"links": [{"from": "n1", "to": "n2", "...": "fields above", "misses": 0, "heartbeatAgeMs": 420}],
"summary": {"linksByState": {"reachable": 20}, "clockSync": {"in": 20, "out": 0}, "maxAbsOffsetMs": 3,
            "messagingDisabled": 0, "inflight": 2, "pending": 1, "queued": 0, "failures": {"NO_LISTENER": 1}}
```

- `limits.inflight`: above this many messages in flight at the node, `deliver` answers `PEER_OVERLOADED`.
- `queued`: sends waiting for the node's messaging to be enabled. `pending`: requests this node sent that have no
  outcome yet.
- `dedup.size`: message ids in the duplicate cache; `dedup.hits`: duplicates caught since reset.
- `gateway.registered`: the node holds a gateway token. `gateway.lastProbeAgeMs`: ms since the gateway's last probe,
  `null` when the node does not route via the gateway.
- `counters.sent`: messages the node put on the wire (counted after messaging was enabled; `response` = answers it
  produced). `counters.received`: messages accepted for this node (duplicates not counted; `response` = answers to its
  own requests). `counters.failures`: error codes of section 2 for sends from this node, one per failed send, or one
  per failed destination of a broadcast.
- Link `misses`: consecutive missed heartbeats; `heartbeatAgeMs`: ms since the last answered heartbeat, `null` if
  never. Gateway links have `misses: null` and `heartbeatAgeMs` from the last gateway contact.
- `summary`: the same, summed over all nodes and links. `maxAbsOffsetMs` is `null` when no link has an offset.

**Per peer and peer views (additive).**

```json
"counters": {"...": "totals above",
  "byPeer": {"n2": {"sent": {"request": 2, "response": 0, "oneway": 1, "broadcast": 1},
                    "received": {"request": 0, "response": 1, "oneway": 0, "broadcast": 0},
                    "failures": {"NO_LISTENER": 1}}}},
"links": [{"from": "n1", "to": "n2", "via": "gateway", "state": "unreachable", "peerStatus": "down",
           "clockSync": null, "offsetMs": null,
           "lastHeartbeatTs": 1792915200123, "misses": null, "heartbeatAgeMs": 640}],
"summary": {"...": "fields above", "peerViews": {"reachable": 16, "unreachable": 4}}
```

- `counters.byPeer`: the same counters split by the other node, in both modes. Sent and failures go to the
  destination (a broadcast: one per destination in `delivered` or `failed`); received to the envelope's
  `source.nodeId`. Only peers with traffic have an entry, at most 64. The totals do not change.
- `via` on a link: `mesh` for a mesh link, `gateway` for a peer view. Node-to-gateway links have no `via`.
- **Peer views** (gateway mode only): each cluster node has one link per other node with `via: "gateway"`, taken
  from the `peers` field of the gateway's probe (section 6). States map `up` and `slow` → `reachable`, `restarting` →
  `restarting`, `down` → `unreachable`, `leaving` → `disabled`; `peerStatus` keeps the gateway's raw status (`null`
  when `unknown`). `unknown` (outside the link-state machine) when the
  gateway never sent `peers`, left the peer out of its latest probe, or the probes stopped for 3 × `probeIntervalMs`.
  `lastHeartbeatTs` is the latest probe that named the peer. Peer views do not count in `possibleLinks`,
  `openConnections` or `summary.linksByState`; `summary.peerViews` counts them by state.
- **Fast fail on peer views:** in gateway mode, a request or one-way send to a node whose peer view (from the
  sender's own latest probe, fresh as defined above) is `unreachable` (gateway says `down`) or `disabled` (`leaving`)
  fails at once with `NODE_UNAVAILABLE` and `at: "node"`, the same code mesh mode gives for an unusable link. It is
  not sent to the gateway, and it is counted in `counters.failures` and `byPeer` like any failed send. `reachable`
  (`up`, `slow`), `restarting` and `unknown` views, stale views, and broadcasts are sent through the gateway as
  before. Mesh mode does not use peer views.
- `counters.failures` and each `byPeer[..].failures` hold at most 32 distinct codes; further codes count as `OTHER`.

**Last run per mode (additive).** `metrics.mesh` and `metrics.gateway` above are unchanged. `metrics.lastRun` keeps
each mode's results over the whole time spent in it:

```json
"metrics": {"...": "mesh and gateway above",
  "lastRun": {
    "mesh": {"startedTs": 1792915100000, "endedTs": 1792915160000, "durationMs": 60000, "nodes": 5,
             "openConnections": 20, "possibleLinks": 20, "openPairs": 10, "possiblePairs": 10, "messages": 1200, "p50Ms": 4, "p95Ms": 11,
             "throughputPerSec": 20, "errorRate": 0.01, "detectMsAvg": 3050, "failures": {"NO_LISTENER": 12}},
    "gateway": {"startedTs": 1792915160000, "endedTs": null, "...": "same fields, run in progress"}}}
```

- A run starts on `POST /api/reset` (for the reset mode) and on a successful mode switch (for the new mode); it
  replaces that mode's previous run. On a successful switch the old mode's run is frozen: `endedTs` set,
  `nodes`/`openConnections`/`possibleLinks`/`openPairs`/`possiblePairs` as they were when the switch started. A
  failed switch freezes nothing.
- A finished run with at least one message is not replaced by an empty one: after a switch into that mode the old
  run stays in `lastRun` (still with its `endedTs`) until the first message or detection in the mode. The new run
  then starts with `startedTs` = the time of the switch. A mode whose last run is `null` or has no messages starts
  its new run right away.
- While a mode's current run is active it is live: `endedTs: null`, duration and topology as of now. A mode never
  run is `null`. Reset clears both.
- `messages`, `errorRate`, `throughputPerSec` (messages / duration) and `failures` (one code per failed send, the
  first failed code for a broadcast) cover the whole run. `p50Ms`/`p95Ms` come from a uniform reservoir sample of
  at most 2000 latencies per run. `detectMsAvg` averages the run's detections, `null` if none.

### `GET /t/farzad/api/events?since=<seq>`

Returns events with `seq` greater than `since` (exclusive), oldest first, at most 200.

- `seq` is the `seq` of the last event returned. Use it as the next `since`.
- `more` is `true` when more events after it are already waiting. Call again right away.
- `truncated` is `true` when events after `since` had already been dropped from the buffer (the last 2000 are kept),
  so the client has missed some.

```json
{"seq": 1042, "more": false, "truncated": false, "events": [
  {"id": "farzad-1041", "seq": 1041, "ts": 1792915200123, "type": "message.request", "from": "n1", "to": "n4",
   "ok": true, "latencyMs": 6, "errorCode": null, "mode": "mesh", "messageId": "n1-1042", "requestId": "r-88"},
  {"id": "farzad-1042", "seq": 1042, "ts": 1792915200400, "type": "node.down", "from": "n1", "to": "n3",
   "ok": false, "latencyMs": null, "errorCode": "NODE_UNAVAILABLE", "mode": "mesh", "detectMs": 3100}
]}
```

These base fields are shared with the Gateway team's events: `id`, `ts`, `type`, `from`, `to`, `ok`, `latencyMs`,
`errorCode`. Fields that do not apply are `null`. Extra fields per type are allowed. `id` is `farzad-<seq>`, so it
does not clash with the gateway's events. `from` and `to` are node IDs, `"gateway"`, or `"*"` for a broadcast. For
node events, `from` is who detected it and `to` is the node it is about.

Event types: `message.request`, `message.oneway`, `message.broadcast`, `request.aborted`, `node.up`, `node.down`,
`node.restarting`, `node.leaving`, `link.state`, `mode.change`, `messaging.enabled`, `messaging.disabled`, `chaos`.

## 6. Gateway mode (what we expect from Gateway, team pisak)

Agreed in `#build`. The exact bodies are to be confirmed against `projects/pisak/CONTRACT.md`.

- **Register:** `POST /t/pisak/api/register` with
  `{"nodeId": "n1", "apps": [{"appId": "echo", "listenerIds": []}], "deliverUrl": "/t/farzad/n/n1/deliver", "heartbeatUrl": "/t/farzad/n/n1/heartbeat", "external": false}`.
  The answer carries a token: `{"token": "..."}`.
- **Route:** `POST /t/pisak/api/route` with the envelope from section 1 and the header
  `Authorization: Bearer <token>`. The gateway delivers to the node's `deliverUrl` and returns the node's answer, or
  an error from section 2. For a broadcast the gateway fans out to every registered node in `scope` except the
  sender, and returns `{"delivered": [...], "failed": [...]}`.
  The gateway respects `ttlMs` as the end-to-end budget, retries included.
- **Deregister:** `POST /t/pisak/api/deregister` with `{"nodeId": "n1"}` and the same `Authorization` header, when
  leaving gateway mode or when the node is stopped.
- **Failures:**
  - A `401` from route makes the node register again once, then retry the message once. At most one registration
    per node is in flight: sends that hit `401` together share it. A send whose token was already replaced by a
    newer registration does not register again; it retries with the current token. So a gateway that issues a new
    token on every register does not turn a gateway restart into `REJECTED` (`auth`) errors.
  - A node in gateway mode that gets no gateway probe for 3 × `probeIntervalMs` (from the register answer, default
    1000) registers again. This covers a gateway restart, which forgets every registration.
  - A failed register: see the mode switch in section 4.
  - When the gateway does not answer, the node answers its sender with `NODE_UNAVAILABLE` and `at: "gateway"`.
  - A failed deregister is logged and ignored.
- **Peers in the probe (additive):** the probe body may carry `"peers": {"n2": "up", "n3": "down", ...}` with
  `up`, `slow`, `down`, `restarting` or `leaving` for the other nodes the gateway knows (pisak gateway v0.5). The node ignores its own id and
  shows the rest as peer views (section 5). Without `peers`, the views are `unknown`.

## 7. Application message types

Each application defines its own message types as numbers (`msgTypeId`) and keeps its own parameters in `payload`.
It can give the numbers readable names when it registers (`"msgTypes": {"1": "QUERY", "2": "QUERY_RESULT"}`).
Events and the Dashboard show the name instead of the number.

## What changed since 0.1

- **Envelope:**
  - new `proto`, `version` and `scope`, and optional `msgTypeId` and `listenerId`;
  - `messageId` format `<nodeId>-<counter>`;
  - `ttlMs` is now the end-to-end budget.
- **Addressing rules:** all apps on one node, one app on all nodes, listener instances, broadcast fan-out.
- **New error codes:** `NO_LISTENER`, `PEER_OVERLOADED`, `MESSAGE_TOO_LARGE`, `BAD_PROTOCOL`, `MODE_SWITCH_FAILED`,
  `MIN_NODES`. `REJECTED` has a `reason`.
- **Delivery:**
  - one-way failures are returned to the sender;
  - duplicate suppression;
  - heartbeat `seq`, `state` and clock sync;
  - link states.
- **Send:** async requests with abort, `userData`, and `outcome`.
- **Mode switch:**
  - commits per node, and rolls back only when the gateway itself fails;
  - nodes that are down are skipped;
  - sends are queued while a node is disabled.
- **External nodes:** always reached through the gateway.
- **Gateway links:** state comes from the calls to the gateway.
- **Events:** paging with `more` and `truncated`.
- **Chaos:** new actions `restart` and `skew`.
- **Breaking, state:** `connections` is replaced by `possibleLinks` and `openConnections`.
- **Breaking, events:** events use the shared shape. `kind` is now `type`, and `error` is now `errorCode`.

## Additive changes after 0.2

Compatible with 0.2: no field is renamed or removed, and defaults are unchanged.

- **detectMs in gateway mode** is measured from the kill to when our runtime sees the gateway's down report, the same
  definition as mesh (section 5). Before, it copied the gateway's figure. The gateway's figure is on the `node.down`
  event as `gatewayDetectMs`.
- **Single-flight gateway registration** and a token-aware retry on `401` (section 6).
- **Fast fail in gateway mode** when a fresh peer view says the destination is down or leaving: `NODE_UNAVAILABLE`,
  `at: "node"` (section 5).
- **Traffic `includeDown`** (opt-in) lets the generator target killed and restarting nodes (section 4). A node that
  comes back in gateway mode is no longer remembered as reported down.
- **lastRun** keeps a finished run with messages until the new run of that mode has traffic (section 5).
- **`possiblePairs` / `openPairs`** in `/state` and in `lastRun` (section 5).
