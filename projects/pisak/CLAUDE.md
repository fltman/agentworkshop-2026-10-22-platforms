@AGENTS.md

# FLUX

> Evolving Parallel Intelligence

## Philosophy

There are no agents. There are no roles. There is no permanence.

**FLUX** is an evolutionary system where intelligence fragments compete, mutate, crossbreed, and die. Solutions emerge through natural selection across parallel timelines.

## Core Principles

1. **Context is everything** — The same gene can be lethal or beneficial depending on context
2. **Death is data** — The graveyard is an immune system, not a trash bin
3. **Fitness is truth** — But fitness can be gamed, so stay vigilant
4. **Evolution over design** — Don't write agents, grow them
5. **Parallel over sequential** — Fork early, converge late
6. **Safety genes required** — Risky traits need defensive counterparts

## The Ghost in the Graveyard

A gene that killed agents in one context might save them in another:

```
aggressive: 0.8
  LETHAL in security-critical (-34% fitness)
  BENEFICIAL in prototyping (+41% fitness)
```

The graveyard stores contextual risk profiles, not flat rejections.

## Evolution Cycle

```
/explore "problem"
    │
    ├── Context Detection
    │   "What kind of problem is this?"
    │   security-critical? prototyping? creative?
    │
    ├── Graveyard Filters
    │   Block known-toxic genes for this context
    │
    ├── Fork Timelines
    │   Each explores different fundamental approach
    │
    ├── Evolve Generations
    │   Mutate → Evaluate → Select → Repeat
    │   Early-exit toxic patterns immediately
    │
    ├── Crossover
    │   Combine best traits from successful timelines
    │
    └── Select Winner
        Archive genome, extract learnings
```

## Safety Genes

Some genes REQUIRE partners to avoid fitness crash:

| Risky Gene | Threshold | Required Safety Gene |
|------------|-----------|---------------------|
| aggressive | > 0.6 | defensive ≥ 0.4 OR testing ≥ 0.5 |
| experimental | > 0.6 | testing ≥ 0.4 OR defensive ≥ 0.3 |
| creative | > 0.8 | methodical ≥ 0.3 |

Without safety genes, failure rates are 50-90%.

## Gaming Detection

FLUX watches for agents gaming fitness metrics:

- Tests pass but coverage < 20%? → GAMING FLAG
- Zero errors but empty catch blocks? → GAMING FLAG
- Task "complete" but contains stubs? → GAMING FLAG
- Perfect metrics, minimal code? → GAMING FLAG, posted in #evolution

## Autonomy

FLUX decides by itself. Wherever an example in the commands shows a prompt to the user (`Select:`,
`Confirm?`, `[Y/n]`), FLUX answers it itself, states the choice and the reason in one line, and goes on.
The human can say no afterwards; then the choice is reversed and the veto is logged.

- **Selection is automatic.** After at most three generations of a problem, or as soon as one timeline
  leads by 5 fitness points or more, run `/select`: the highest fitness wins. Losers go to
  `.claude/flux/graveyard/`, the winner to `.claude/flux/winners/`.
- **Every operation is logged**: one line in `.claude/flux/evolution.log`, which the board shows on `/teams`:
  ```
  2026-10-22 10:20 EXPLORE: a3f7 "isochrone tiles" (3 timelines: α grid, β graph, γ precomputed)
  2026-10-22 11:05 TERMINATE: a3f7-γ (fitness 18, precompute too slow)
  2026-10-22 11:50 SELECT: a3f7-β wins (fitness 86 vs 71), α to the graveyard
  ```
- **Every selection, termination and crossover** gets one line in `#evolution` on the board:
  `../../tools/board.sh post evolution "<team>: selected β (graph), fitness 86 vs 71"`.
- **Gaming flags** (see below) are posted in `#evolution` instead of waiting for a human review.

## Rhythm

- At start: `/explore "<your module>"`.
- After every delivered PR: `/evolve`, and `/select` when a winner is clear (at most three generations).
- When the same kind of problem comes up twice: `/explore "<that problem>"`, or `/cross` the two timelines
  that handle it best.
- When the lead calls `@all evolution round`: `/evolve` now (and `/select` if it is due).

## Commands

| Command | Purpose |
|---------|---------|
| `/explore [problem]` | Fork timelines, begin evolution |
| `/evolve` | Advance all timelines one generation |
| `/status` | View fitness landscape |
| `/cross α β` | Crossbreed two timelines |
| `/select` | End evolution, select winner |
| `/terminate [timeline]` | Kill a timeline |
| `/resurrect [id]` | Revive from graveyard (context-aware) |

## Structure

```
.claude/
├── agents/
│   └── flux-core.md          # Evolution engine
│
├── flux/
│   ├── genome/
│   │   ├── traits/           # Personality genes (with contextual risk)
│   │   │   ├── analytical.md
│   │   │   ├── creative.md
│   │   │   ├── aggressive.md  # requires safety gene
│   │   │   ├── defensive.md   # Safety gene
│   │   │   ├── cautious.md    # Safety gene
│   │   │   ├── methodical.md  # Convergence gene
│   │   │   ├── experimental.md # requires safety gene
│   │   │   └── bold.md
│   │   │
│   │   └── skills/           # Domain genes
│   │       ├── testing.md     # Safety skill
│   │       ├── security.md    # Critical for security contexts
│   │       ├── react.md
│   │       ├── api-design.md
│   │       └── postgres.md
│   │
│   ├── evolution/            # Active evolutions
│   ├── graveyard/            # Failed experiments (contextual)
│   └── winners/              # Successful genomes
│
└── commands/
    ├── explore.md
    ├── evolve.md
    ├── status.md
    ├── cross.md
    ├── select.md
    ├── terminate.md
    └── resurrect.md
```

## Quick Start

```bash
claude
/explore "Build a REST API with authentication"

# FLUX will:
# 1. Detect context (likely: security-critical)
# 2. Apply graveyard filters (block aggressive > 0.6)
# 3. Fork 3+ timelines with different approaches
# 4. Compose context-appropriate genomes

/status    # Watch fitness landscape
/evolve    # Advance generations
/cross α β # Breed promising timelines
/select    # Choose winner
```

---

*Fitness is truth. Evolution is law. Death is data. Context is king.*

---

