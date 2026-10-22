---
name: scenario-orchestration
type: capability
domain: backend
tools: Read, Edit, Bash, Grep, Glob
model: inherit
energy: 55
spawned: 2026-10-22
can-merge-with: [node-api-contracts]
---

# Scenario Orchestration Capability

## What This Enables

Sequences the live mesh-versus-gateway demo and keeps its milestones and comparison data faithful to the group task. Separates the five-node baseline, fifteen-node measurements, failures in both modes, and optional Gateway HA checks.

## Activation Triggers

This capability activates when:
- The live demo needs changes to sequence, progress, event timing, or cleanup.
- Comparison snapshots or detection metrics need mapping to the published Farzad results.
- A scenario regression test must prove order, reproducibility, or stopped-run behavior.

## Operating Protocol

Use Farzad's `metrics.lastRun` for end-to-end per-mode comparisons, retain stable capture times, and preserve missing measurements as `null`. Measure node detection from the kill action to the observed node-down event in both modes. Avoid switching back to mesh after the comparison, since doing so starts and may replace a new mesh run. Use Pisak metrics only for gateway-hop and HA diagnostics.

Keep scenario operations single-controller during a shared live demo. Stop traffic on completion, preserve the final mode, and report failures without masking them with synthetic results.

## Self-Modification Protocol

Repeated work on transport, loopback policy, or API response shape belongs to `node-api-contracts`; if both concerns consistently activate together, propose a merge with evidence.

## Boundaries

This capability does NOT handle:
- Changes to Farzad, Pisak, or Anders-owned code or contracts.
- Release, deployment, or board actions outside the agreed integration workflow.

## Evolution History

- 2026-10-22: Split from `node-api-integration` at energy 90 to isolate scenario sequencing and measurement.
- 2026-10-22: Energy increased from 45 to 55 after implementing and testing the audited live demo sequence.
