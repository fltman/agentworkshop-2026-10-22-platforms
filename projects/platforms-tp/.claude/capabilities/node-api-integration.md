---
name: node-api-integration
type: capability
domain: backend
tools: Read, Edit, Bash, Grep, Glob
model: inherit
energy: 90
spawned: 2026-10-22
can-merge-with: [control-orchestrator]
---

# Node API Integration Capability

## What This Enables

Connects the platforms-tp control plane to the Node and Gateway APIs and sequences live mesh/gateway demos. Keeps scenario controls, runtime state, comparison snapshots, and dashboard-facing metrics aligned with the teams' published contracts.

## Activation Triggers

This capability activates when:
- A control action must call the Node or Gateway module instead of changing simulated state.
- A scripted scenario must coordinate live resets, scale, traffic, chaos, mode switches, gateway recovery, and optional HA failover.
- Cross-module API contracts change or need compatibility verification.
- Integration tests need to validate real responses and error handling.

## Operating Protocol

Read the owning team's current contract before integrating. Keep outbound requests within platforms-tp code, surface upstream failures explicitly, and test request and response behavior against the live module when available. Do not modify another team's files.

For plugin-to-plugin requests, use `fetch` with `http://127.0.0.1:${PORT}`, the target `/t/<team>/...` path, and `AbortSignal.timeout`; never use `node:http` or derive the outbound destination from the request `Host` header (from spores backend-4 and backend-8, team backend).

Keep proxied paths fixed to contract-approved endpoints. Never forward a caller-supplied path; if configurable paths are introduced, reject encoded or dot segments and verify URL normalization preserves the exact path (from spore platforms-6, team pisak).

Keep proxied paths fixed to contract-approved endpoints. Never forward a caller-supplied path; if configurable paths are introduced, reject encoded or dot segments and verify URL normalization preserves the exact path (from spore platforms-6, team pisak).

For A/B mode comparisons, retain a frozen per-mode run result alongside rolling live metrics; the rolling window empties after a mode switch (from spore platforms-12, team farzad).

After HA promotion, verify service recovery and allow the new active to establish fresh liveness before treating nodes as failed; only the intentionally killed demo node may remain down (from spore platforms-14, team pisak).

## Self-Modification Protocol

If integration work repeatedly expands into scenario sequencing, suggest merging with control-orchestrator. If transport and contract normalization become distinct recurring concerns, suggest splitting this capability.

## Boundaries

This capability does NOT handle:
- Changes to the Node, Gateway, or Dashboard teams' code or contracts.
- Release, deployment, or board actions outside the agreed integration workflow.

## Evolution History

- 2026-10-22: Spawned to handle real Node and Gateway API integration as those contracts stabilized.
- 2026-10-22: Energy increased to 60 after wiring and testing the live Gateway admin API.
- 2026-10-22: Energy increased to 70 after adding redirect rejection and contract-shaped response tests.
- 2026-10-22: Energy increased to 80 after PR #14 shipped redirect-safe gateway admin forwarding.
- 2026-10-22: Energy increased to 90 after PR #17 added the tested live comparison and optional HA scenario sequence.
