---
include-custom-instructions: true
name: timeline-α-gen-003
description: FLUX 21e3687b α. Active/standby gateway pair behind one URL, registry replicated every tick, promotion after detectMs. Child of c1f74c17-α.
timeline: α
generation: 3
parent: c1f74c17-winner
problem-hash: 21e3687b
type: winner
fitness-history:
  - gen-001: 87 (gate 19/19 run three times, no change needed from other teams 20/20, HA off is byte-for-byte v0.5 behaviour 20/20, measurable failover for the demo 17/20, replication honesty documented 10/20)
  - gen-002: 92 (gate 20/20 run three times, new test fails on gen-001; platforms-tp adopted v0.6 in 4 minutes with no clarifying question; the 250 ms replication window is closed by write-through)
  - gen-003: 93 (gate 21/21; live /state on the board carries ha and the API reports contract v0.6; byte-identical HA-off check against a plain v0.5 Gateway, spore backend-10; tile shows the pair)
genome:
  traits: [analytical: 0.6, methodical: 0.6, defensive: 0.8, bold: 0.3]
  skills: [api-design: 0.7, testing: 0.8, observability: 0.6]
---
Approach: GatewayPair (board/plugins/pisak/ha.js) wraps instances a and b, which share Events and Metrics. Off by
default. With HA on, the active's snapshot (identities, urls, tokens, planned state) is restored into the standby
every 250 ms tick. When the active goes down, the standby is promoted after detectMs, lastSeen is reset and it probes
the nodes itself. Breakers, rate buckets and latency samples are not replicated. Contract v0.6, section 9.
gen-002 mutation (self-proposed, defensive 0.7 -> 0.8, bold 0.4 -> 0.3): register and deregister are written through
to the standby at once, so a token handed out just before a kill survives the failover.

Learned: keep the wrapper's interface identical to Gateway, so index.js only changes its constructor; and make the
HA-off path the default so the teams that depend on "a dead gateway stays dead" are not affected.
gen-003 mutation (spore backend-10, testing 0.7 -> 0.8, observability 0.5 -> 0.6): every additive change is proven
byte-identical to the old module with the feature off, and the tile shows HA state for the demo.
