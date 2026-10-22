---
include-custom-instructions: true
name: timeline-α-gen-002
description: FLUX 41f2ac56 α. GET-only gateway watcher for demo runs that tells a board restart (routes counter drops) from an admin reset (events cleared) and a gateway fault.
timeline: α
generation: 2
problem-hash: 41f2ac56
type: winner
fitness-history:
  - gen-001: 84 (works today with no deploy and no contract change 30/30; local test against a real board: admin reset gives no false RESTART, server restart flagged within one poll, node-down shown with detectMs 30/30; read-only by construction 20/20; only the team sees it live, not the room 4/20)
  - gen-002: 89 (local test with reset, HA failover, board restart and SIGTERM: SUMMARY adds 3+2 routed across the reset to 5, 1 failover at 1178 ms, 1 restart, all right; the room gets one post-ready line instead of a hand-read log 9/20)
genome:
  traits: [cautious: 0.7, methodical: 0.6, analytical: 0.6, bold: 0.1]
  skills: [observability: 0.8, testing: 0.6, reporting: 0.5]
---
Approach: poll /state, /metrics and /events every 2 s. A process restart is the only thing that lowers state.routes
(admin reset keeps it, gateway kill/revive keep it, HA failover sums both instances), so routes going down is the
RESTART signal. gateway.startedAt was rejected as the signal: revive and HA failover change it too.
Learned: during a freeze, the best observation tool is the one that needs no deploy.
gen-002 mutation (self-proposed, +reporting 0.5): after the aborted dry run the report to #build was written by hand
from raw polls. Now the watcher keeps peaks and totals per counter segment (an admin reset or a restart starts a new
segment) and prints one SUMMARY line on exit, time up, Ctrl-C or SIGTERM.
