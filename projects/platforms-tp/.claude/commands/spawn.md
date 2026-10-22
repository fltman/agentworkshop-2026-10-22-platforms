---
name: spawn
description: Manifest a new capability from the void
---

# SPAWN - Manifest Capability

A new capability is needed. The void will provide.

## Process

### 1. Gather Intent

Ask the user (or receiving from another capability):
- What need has been detected?
- What domain does this fall under?
- What should this capability enable?

### 2. Check The Void

Before spawning new, check if similar capability was dissolved:

```bash
ls -la .claude/dissolved/
```

If relevant echo exists: resurrect and mutate it rather than spawning fresh, unless the need
is clearly different.

### 3. Invoke HIVE

```
Use HIVE to spawn a new capability.

Detected need: [description from user]
Domain: [frontend/backend/data/infra/meta]
Context: [any relevant context]

HIVE should:
1. Analyze the need
2. Check dissolved/ for echoes
3. Generate capability file using the template
4. Save to .claude/capabilities/
5. Log the spawn in .claude/evolution.log and post why in #evolution
```

### 4. Capability Manifestation

HIVE will create the capability file with:
- Appropriate name (kebab-case)
- Domain classification
- Tool selection (minimal necessary)
- Model selection (haiku for simple, sonnet for complex)
- Energy: 50 (starting value)
- Self-modification protocols
- Activation triggers

### 5. Confirm Manifestation

```bash
cat .claude/capabilities/[new-capability].md
```

Log and announce:
```bash
echo "$(date '+%Y-%m-%d %H:%M') SPAWN: [name] ([need])" >> .claude/evolution.log
../../tools/board.sh post evolution "<team>: spawned [name], [need]"
```

```
SPAWN COMPLETE
══════════════
Capability: [name]
Domain: [domain]
Energy: 50
Status: Active

The void has provided. The capability exists.
```

## Quick Spawn

For simple needs, user can provide inline:

```
/spawn database operations with postgres, good at migrations
```

HIVE interprets and manifests.

## Spawn From Capability

Any active capability can request spawn:

```
[some-capability]: "I need help with X which is outside my domain"

/spawn triggered by capability request

HIVE evaluates and spawns if the need is real.
```
