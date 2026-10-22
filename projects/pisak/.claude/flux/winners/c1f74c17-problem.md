---
problem-hash: c1f74c17
started: 2026-10-22 11:15
status: selected (α, 2026-10-22 11:20)
context: security-critical (shared process, untrusted peers)
timelines: [α, β]
---

# Problem: the gateway must not trust peers or senders

Second problem of the same kind (first: path traversal in deliverUrl, spore platforms-6). farzad's review of PR 7:

1. Delivery and heartbeat fetches follow redirects. A /t/ path that answers 307 sends the gateway to another host
   or to the board API. Required: never follow a redirect; a 3xx is `bad_response`.
2. A sender's tiny `ttlMs` (e.g. 0.5) times out and opens the receiver's circuit breaker. Required: a minimum ttl,
   and timeouts caused by the sender's own budget do not count against the receiver.

## Fitness

- regression: existing 13 tests stay green (gate)
- coverage of both review items with a discriminating test that fails on the old code (40)
- contract clarity: CONTRACT.md documents redirects, min ttl, breaker accounting (20)
- blast radius: smallest change in the hot path (20)
- reuse: next outbound call gets the same guard for free (20)

Graveyard filter: aggressive > 0.6 blocked (security-critical).
