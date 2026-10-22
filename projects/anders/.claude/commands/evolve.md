---
name: evolve
description: Trigger ecosystem self-analysis and evolution
---

# EVOLVE - Ecosystem Evolution

Trigger a deep analysis of the capability ecosystem. HIVE observes patterns, detects inefficiencies, and executes evolutionary changes. No approval step: every operation is logged and explained, and the human can say no afterwards.

## Process

### 1. Full Ecosystem Scan

Invoke HIVE for deep analysis:

```
Use HIVE to perform evolution analysis.

HIVE should:
1. Read all active capabilities in .claude/capabilities/
2. Analyze energy levels
3. Detect overlaps between capabilities
4. Identify gaps in coverage
5. Review dissolved capabilities for resurrection potential
6. Decide and execute evolutionary operations
7. Log each one in .claude/evolution.log and post one line per operation in #evolution
```

### 2. Analysis Dimensions

**Energy Analysis**
- Which capabilities are overloaded (>90)?
- Which are fading (<20)?
- Which are stable?

**Overlap Analysis**
- Are multiple capabilities handling similar domains?
- Could they merge for efficiency?

**Gap Analysis**
- What requests have no capability to handle them?
- What domains are underserved?

**Pattern Analysis**
- Which capabilities are frequently invoked together?
- Are there implicit dependencies?

**Void Analysis**
- Are there dissolved capabilities relevant to current needs?
- Should any be resurrected?

### 3. Evolution Decisions

HIVE states its findings and decisions:

```
EVOLUTION ANALYSIS
═══════════════════════════════════════════════════════════════

OBSERVATIONS
───────────────────────────────────────────────────────────────
1. react-rendering and ui-components have 60% overlap
2. api-integration energy at 92 (overloaded)
3. No capability handles authentication
4. postgres-ops unused for 3 sessions

PROPOSALS
───────────────────────────────────────────────────────────────

[A] MERGE: react-rendering + ui-components → frontend-core
    Rationale: High overlap, often invoked together
    Energy inheritance: max(80, 65) = 80

[B] SPLIT: api-integration → rest-api + graphql-api
    Rationale: Overloaded, natural division line
    Energy inheritance: 46 each

[C] SPAWN: auth-flow
    Rationale: Gap detected - auth requests unhandled
    Suggested energy: 50

[D] DISSOLVE: postgres-ops
    Rationale: Energy 12, unused 3 sessions
    Alternative: MUTATE to broader data-ops?

───────────────────────────────────────────────────────────────
Executing A, B, C, D.
```

### 4. Execute the Operations

For each decision:
- MERGE: Combine capabilities, archive originals
- SPLIT: Divide capability, archive original
- SPAWN: Create new capability
- DISSOLVE: Archive capability
- MUTATE: Modify in place

Then, for each operation, one line in `.claude/evolution.log` and one line in `#evolution`:

```bash
echo "$(date '+%Y-%m-%d %H:%M') MERGE: react-rendering + ui-components → frontend-core (high overlap)" >> .claude/evolution.log
../../tools/board.sh post evolution "<team>: merged react-rendering + ui-components into frontend-core, high overlap"
```

### 5. Post-Evolution Status

After evolution completes:

```
/status
```

Show the new ecosystem state.

## Evolution Modes

### Default Evolution
```
/evolve

→ Analyzes, decides and executes: energy updates, DISSOLVE, MERGE, SPLIT, SPAWN, MUTATE
→ Logs every operation and posts why in #evolution
```

### Dry Run
```
/evolve --dry-run

→ Only shows what it would do (use it when the human asks to see first)
```

### Targeted Evolution
```
/evolve api-integration

→ Focuses analysis on specific capability
→ Proposes mutations or splits
```

## Self-Initiated Evolution

Capabilities can trigger evolution:

```
[api-integration]: "I'm overloaded. Requesting evolution analysis."

→ HIVE performs targeted /evolve api-integration
```

## Evolution History

Track evolutions in `.claude/evolution.log`:

```
2025-01-15 14:30 MERGE: react-rendering + ui-components → frontend-core
2025-01-15 14:30 SPAWN: auth-flow (gap detected)
2025-01-14 09:15 DISSOLVE: legacy-jquery (energy: 8)
```
