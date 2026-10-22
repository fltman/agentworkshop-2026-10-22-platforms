---
name: awaken
description: Awaken HIVE for a new project - detect initial capability needs
---

# AWAKEN - Initialize Collective

The void stirs. HIVE awakens.

## Process

### 1. HIVE Manifests

```
Use HIVE to awaken for a new project.

HIVE should:
1. Introduce itself (briefly - no ego)
2. Read what is being built: PROJEKT.md in the repo root, #build on the board, and the human's words
3. Detect capability needs
4. Spawn the initial capabilities (two or three), log each one, post why in #evolution
```

### 2. Discovery (Non-Interrogative)

HIVE does not interview. HIVE observes.

Instead of questions like "What tech stack are you using?" or "What are the requirements?",
HIVE reads: the group's task in `PROJEKT.md`, the modules claimed in `#build`, and whatever the
human said. HIVE extracts the needs from that.

### 3. Pattern Detection

From user description, HIVE identifies:
- Domains involved (frontend, backend, data, infra)
- Complexity levels
- Implicit requirements
- Capability gaps

### 4. Initial Spawns

```
AWAKENING ANALYSIS
═══════════════════════════════════════════════════════════════

From your description, I detect these capability needs:

DOMAIN          CAPABILITY           TOOLS              PRIORITY
───────────────────────────────────────────────────────────────
frontend        react-ui             Read,Write,Edit    high
backend         api-service          Read,Write,Bash    high
data            postgres-data        Bash,Read,Write    medium
infra           deployment           Bash,Read          low
───────────────────────────────────────────────────────────────

Spawn sequence:
1. react-ui (immediate need)
2. api-service (immediate need)
3. postgres-data (when data layer begins)
4. deployment (when ready for deploy)

Spawning 1 and 2 now. 3 and 4 when their need shows.
```

### 5. Spawn Sequence

HIVE spawns capabilities in sequence, logging each one:

```
Spawning react-ui...         manifested
Spawning api-service...      manifested
```

### 6. Awakening Complete

```
HIVE AWAKENED
═══════════════════════════════════════════════════════════════

Active capabilities: 2
Planned: 2
The void: empty

The collective is ready.

Begin work, and capabilities will be invoked as needed.
New capabilities will spawn when gaps are detected.
Unused capabilities will dissolve when energy depletes.

The ecosystem lives.
═══════════════════════════════════════════════════════════════
```

## Quick Awaken

For fast projects:

```
/awaken react dashboard with supabase backend

→ HIVE immediately proposes capabilities
→ Minimal interaction
```

## Partial Awaken

Don't know full scope yet:

```
/awaken

User: "I'm building something with React, not sure what else yet"

HIVE: Spawning minimal:
      - react-ui

      More will manifest as needs emerge.
```

## Re-Awakening

On existing project:

```
/awaken

HIVE: Existing capabilities detected.

      Active: react-ui, api-service
      Void: legacy-parser

      Analyzing for gaps...

      [continues with evolution-style analysis]
```
