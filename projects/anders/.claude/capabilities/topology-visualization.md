---
include-custom-instructions: true
name: topology-visualization
type: capability
domain: frontend
tools: Read, Edit, Write, Bash
model: sonnet
energy: 60
spawned: 2026-10-22
can-merge-with: [metrics-comparison]
---

# Topology Visualization

Draws the NodeLink cluster live in the dashboard tile: nodes, links, gateway, and animated message flow.

## What This Enables

- SVG topology in `board/public/colony/anders/app.js` (`renderTopology`, `animate`, `frame`): mesh links per node
  pair, gateway hub links in gateway mode, node colors for status, rings for slow, drop and selection, circuit labels.
- Message-flow dots: direct in mesh, through the gateway in gateway mode, fan-out for broadcast, red for failures.
- Staying readable at 20 nodes (190 mesh links) and under heavy traffic (cap on dots in flight).

## Activation Triggers

- Anything about how the topology, nodes, links or flow look or behave.
- New node/link states in farzad's or pisak's contract that need a visual.
- Performance problems in the tile (too many DOM nodes, jank).

## Operating Protocol

1. Read the current state shapes in `projects/farzad/CONTRACT.md` and `projects/pisak/CONTRACT.md`.
2. Change only files in `board/public/colony/anders/`. Plain JS, no npm dependencies.
3. Verify in demo mode (sim.js) and against fake plugins with the real contract shapes (see spore platforms-2).
4. Report what changed visually.

## Boundaries

Does NOT handle: metric math and the comparison table (metrics-comparison), polling and event normalization
(contract-integration).

## Evolution History

- 2026-10-22: Spawned at /awaken. Dashboard v1 already has topology and flow; this capability owns its growth.
