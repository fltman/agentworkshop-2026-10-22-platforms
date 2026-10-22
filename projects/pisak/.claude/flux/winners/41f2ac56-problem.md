---
problem-hash: 41f2ac56
problem: "Demo-run observation: tell a gateway fault from a board restart, live, without touching the shared server"
context: demo-critical, read-only (no POSTs during a dry run, no deploys during a dry run)
origin: dry run 12:50 aborted by a deploy mid-run; we only knew it was not our gateway by reading raw polls by hand
---
Timelines:
- α GET-only watcher in the team folder (projects/pisak/tools/watch-gateway.py), runs on our machine, prints state
  changes, non-traffic events and RESTART.
- β restart visibility in the tile (process start time, uptime), seen by everyone in the group app.
- γ server-side incident summary endpoint (/api/demo-report) that the runner could read after a run.
