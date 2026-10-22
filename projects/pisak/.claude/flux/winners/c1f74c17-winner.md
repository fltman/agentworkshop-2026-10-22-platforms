---
include-custom-instructions: true
name: timeline-α-gen-003
description: FLUX c1f74c17 α. Guards at the two call sites, budget-aware breaker accounting. Child of 508b820a-α.
timeline: α
generation: 3
parent: 508b820a-winner
problem-hash: c1f74c17
type: winner
fitness-history:
  - gen-001: 86 (gate 15/15, review coverage 40/40 with tests failing on v0.3, contract 20/20, blast radius 18/20, reuse 8/20)
  - gen-002: 88 (gate 16/16, peers membership in probes for farzad, additive contract v0.5)
  - gen-003: 90 (gate 23/23, farzad audit: bounded token reuse instead of reuse-forever, not_registered for known nodes after a restart; both new tests fail on gen-002)
genome:
  traits: [analytical: 0.6, methodical: 0.6, defensive: 0.8, cautious: 0.4, bold: 0.3]
  skills: [api-design: 0.7, testing: 0.7, security: 0.7, observability: 0.5]
---
Approach: redirect manual on both fetches, 3xx is bad_response (not retried); ttl clamped to [50, 60000];
a TIMEOUT counts against the breaker only when the sender gave at least the gateway's own defaultTtlMs.
Sender-budget timeouts are not counted and not fed into the slow-node median either.

Lesson: every outbound fetch from a shared-process plugin needs redirect manual, and failure accounting must ask whose budget ran out.

Gen-002 mutation: observability 0.5. The gateway shares what it knows (membership in every probe) instead of keeping it for /state only.
gen-003 mutation (cautious 0.0 -> 0.4 from farzad's audit): a convenience a consumer asks for (reuse the token) is granted only
as far as it cannot leak a credential: the caller proves it holds the token, or repeats the same registration within 3 s.
