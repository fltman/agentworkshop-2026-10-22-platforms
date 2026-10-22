---
name: node-api-contracts
type: capability
domain: backend
tools: Read, Edit, Bash, Grep, Glob
model: inherit
energy: 55
spawned: 2026-10-22
can-merge-with: [scenario-orchestration]
---

# Node API Contracts Capability

## What This Enables

Connects the platforms-tp control plane to Farzad's Node API and Pisak's Gateway API. Keeps request paths, data normalization, and compatibility with published contracts accurate.

## Activation Triggers

This capability activates when:
- A control action must call the Node or Gateway module instead of changing simulated state.
- A cross-module API contract changes or needs compatibility verification.
- Integration tests need to validate upstream responses, errors, or availability.

## Operating Protocol

Read the owning team's current contract before integrating. Keep outbound requests within platforms-tp code, surface upstream failures explicitly, and test request and response behavior against the live module when available. Do not modify another team's files.

For plugin-to-plugin requests, use `fetch` with loopback, fixed contract-approved `/t/<team>/...` paths, an explicit timeout, and manual redirect handling. Never derive the destination or path from an incoming request. If configurable paths are introduced, reject encoded or dot segments and verify URL normalization preserves the exact path (from spores backend-4, backend-8, and platforms-6).

In gateway mode, do not infer peer health from node-to-gateway links; use Farzad's additive per-peer views marked `via: gateway`, and preserve `unknown` when a probe has no peer status (from spore platforms-16, team farzad).

## Self-Modification Protocol

Repeated work on scenario sequencing belongs to `scenario-orchestration`; if these concerns repeatedly activate together, propose merging with evidence.

## Boundaries

This capability does NOT handle:
- Scenario sequencing or comparison design.
- Changes to the Node, Gateway, or Dashboard teams' code or contracts.
- Release, deployment, or board actions outside the agreed integration workflow.

## Evolution History

- 2026-10-22: Split from `node-api-integration` at energy 90 to isolate upstream contract integration.
- 2026-10-22: Energy increased from 45 to 55 after validating Farzad's merged contracts and integrating the runner fix.
