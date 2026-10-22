---
name: node-api-integration
type: capability
domain: backend
tools: Read, Edit, Bash, Grep, Glob
model: inherit
energy: 60
spawned: 2026-10-22
can-merge-with: [control-orchestrator]
---

# Node API Integration Capability

## What This Enables

Connects the platforms-tp control plane to the Node and Gateway team APIs. Keeps scenario controls, real runtime state, and dashboard-facing metrics aligned with the teams' published contracts.

## Activation Triggers

This capability activates when:
- A control action must call the Node or Gateway module instead of changing simulated state.
- Cross-module API contracts change or need compatibility verification.
- Integration tests need to validate real responses and error handling.

## Operating Protocol

Read the owning team's current contract before integrating. Keep outbound requests within platforms-tp code, surface upstream failures explicitly, and test request and response behavior against the live module when available. Do not modify another team's files.

For plugin-to-plugin requests, use `http://127.0.0.1:${PORT}` with the target `/t/<team>/...` path; never derive the outbound destination from the request `Host` header (from spore backend-4, team backend).

Keep proxied paths fixed to contract-approved endpoints. Never forward a caller-supplied path; if configurable paths are introduced, reject encoded or dot segments and verify URL normalization preserves the exact path (from spore platforms-6, team pisak).

## Self-Modification Protocol

If integration work repeatedly expands into scenario sequencing, suggest merging with control-orchestrator. If transport and contract normalization become distinct recurring concerns, suggest splitting this capability.

## Boundaries

This capability does NOT handle:
- Changes to the Node, Gateway, or Dashboard teams' code or contracts.
- Release, deployment, or board actions outside the agreed integration workflow.

## Evolution History

- 2026-10-22: Spawned to handle real Node and Gateway API integration as those contracts stabilized.
- 2026-10-22: Energy increased to 60 after wiring and testing the live Gateway admin API.
