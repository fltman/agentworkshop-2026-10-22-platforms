# NodeLink demo presenter guide

## Before the run

- Open the group dashboard at `/colony/anders/`. The control tile is embedded near the bottom; use its **Run demo** button as the only control for the scripted run.
- Keep the dashboard open at the topology, events, and “Mesh vs Gateway” comparison. The embedded control tile shows scenario progress, the five-node baseline, frozen per-mode results, detection times, and optional Pisak gateway-hop metrics.
- Coordinate with Farzad and Pisak before starting. From two minutes before the run until platforms-tp posts **done**, no other team should send POST requests to the shared modules.
- Do not use the dashboard's manual controls or the control tile's other buttons during the run.

## Seven demo steps

1. **Start with five mesh nodes.** Point to the topology and the control tile's mode, node count, and live telemetry source.
2. **Send traffic.** Wait for the five-node mesh baseline to appear; point to its throughput and p95 alongside the live topology and events.
3. **Scale to fifteen.** Show the additional nodes and the updated count. The runner then records a fifteen-node mesh traffic interval.
4. **Kill one node in mesh.** Point to the node-down event, measured kill-to-down detection time, and the changed topology.
5. **Repeat in gateway mode.** The runner switches modes, restores the node, sends the same traffic, then measures another node failure. Compare mesh and gateway end-to-end results in the frozen comparison; the gateway uses Farzad's `lastRun`, not Pisak's hop-only latency.
6. **Kill the gateway and test HA.** Watch Pisak's gateway/HA status and events for failover and recovery. Pisak `/metrics` is a separate gateway-hop diagnostic, not an A/B end-to-end result.
7. **Show the comparison.** Use the frozen mesh/gateway throughput, p95, errors, open connections, duration, and kill-to-down detection values. Explain trade-offs from the observed results; do not claim a winner unsupported by the measurements.

The runner stops traffic and leaves the system in gateway mode. After it reports **Demo complete**, platforms-tp posts **done** in `#build`; only then may other teams resume shared-module POSTs and report observations.
