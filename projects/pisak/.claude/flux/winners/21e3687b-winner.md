---
include-custom-instructions: true
name: timeline-α-gen-001
description: FLUX 21e3687b α. Active/standby gateway pair behind one URL, registry replicated every tick, promotion after detectMs. Child of c1f74c17-α.
timeline: α
generation: 1
parent: c1f74c17-winner
problem-hash: 21e3687b
type: winner
fitness-history:
  - gen-001: 87 (gate 19/19 run three times, no change needed from other teams 20/20, HA off is byte-for-byte v0.5 behaviour 20/20, measurable failover for the demo 17/20, replication honesty documented 10/20)
genome:
  traits: [analytical: 0.6, methodical: 0.6, defensive: 0.7, bold: 0.4]
  skills: [api-design: 0.7, testing: 0.7, observability: 0.5]
---
Approach: GatewayPair (board/plugins/pisak/ha.js) wraps instances a and b, which share Events and Metrics. Off by
default. With HA on, the active's snapshot (identities, urls, tokens, planned state) is restored into the standby
every 250 ms tick. When the active goes down, the standby is promoted after detectMs, lastSeen is reset and it probes
the nodes itself. Breakers, rate buckets and latency samples are not replicated. Contract v0.6, section 9.

Learned: keep the wrapper's interface identical to Gateway, so index.js only changes its constructor; and make the
HA-off path the default so the teams that depend on "a dead gateway stays dead" are not affected.
