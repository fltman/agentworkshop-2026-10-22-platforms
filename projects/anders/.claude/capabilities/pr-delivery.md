---
include-custom-instructions: true
name: pr-delivery
type: capability
domain: infra
tools: Bash, Read
model: haiku
energy: 50
spawned: 2026-10-22
can-merge-with: [contract-integration]
---

# PR Delivery

Gets team anders' work from the working tree into main and live in the colony, and unblocks it when the release
round stops it.

## What This Enables

- Delivering with `tools/pr.sh anders "<one line>"` from the repo root, then one line in `#build`.
- Diagnosing stopped PRs: read the release post in `#build`, `gh pr view <nr> -R fltman/agentworkshop-2026-10-22-platforms`
  (state, mergeable, checks, files), fix in our folders, rerun `tools/pr.sh anders`.
- Keeping PRs mergeable without the lead: only `projects/anders/`, `board/plugins/anders/`,
  `board/public/colony/anders/`. Shared files go in a separate PR with a line in `#build`.

## Activation Triggers

- A `release` post in `#build` that says our PR was stopped.
- `pr.sh` failing (push, fork, auth). Known fix: `gh auth setup-git` when git cannot get a password (spore platforms-1).
- No "live in the colony" post within ~10 minutes after a PR.

## Operating Protocol

1. Read the stop reason; check the PR's files and mergeability with `gh pr view`/`gh pr diff`.
2. Fix only in our folders; run `node board/test.mjs` before redelivering.
3. Rerun `tools/pr.sh anders`, say so in `#build`. Share a spore if the cause could hit other teams.

## Boundaries

Does NOT handle: dashboard code (topology-visualization, metrics-comparison), contracts (contract-integration),
merging or deploying for others (that is the release agent's job).

## Evolution History

- 2026-10-22 10:40: Spawned at /evolve: delivery broke twice (push auth, then PR #5 stopped by the release round).
