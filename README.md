# dsh-session-rescue

**Fix "history unavailable for session … corrupt session log" in DeepSeek Harness — safely, with zero data loss in the common cases.**

[中文文档](README.zh.md)

```sh
npx github:po-et/dsh-session-rescue
```

If dsh greets you with any of these, this tool is for you:

- `corrupt session log: seq gap in committed region at line N (expected X, got Y)`
- `corrupt session log: unparsable committed event at line N`
- `first line is not a session header`
- `SessionPersistenceCorruptionError` after a crash, force-kill, or running two dsh instances on one session

dsh session logs are append-only and strictly validated: one duplicated write after a crash or a second process, and the whole conversation becomes permanently unloadable — even though **your content is usually still all there**. `dsh-session-rescue` diagnoses exactly what dsh's loader rejects, removes the redundant side (replayed rows, stale synthetic interrupt-closers), and rebuilds a loadable log.

## Quick start

> `npx github:…` builds from source on first run (about half a minute); later runs are cached. Once the package is on npm the shorter `npx dsh-session-rescue` will work too.

```sh
# 1. See which sessions are broken (safe, read-only)
npx github:po-et/dsh-session-rescue

# 2. Deep-diagnose one session (path or any unique id fragment)
npx github:po-et/dsh-session-rescue doctor 37374e34

# 3. Preview the repair — nothing is written yet
npx github:po-et/dsh-session-rescue repair 37374e34

# 4. Apply it (a timestamped backup is always kept; close dsh first)
npx github:po-et/dsh-session-rescue repair 37374e34 --apply
```

Can't be repaired? Get your conversation back anyway:

```sh
npx github:po-et/dsh-session-rescue export 37374e34        # salvages the transcript to Markdown
npx github:po-et/dsh-session-rescue quarantine 37374e34    # move a broken session out of dsh's sight
```

Using an AI agent? Just tell it: *"Run `npx github:po-et/dsh-session-rescue` and fix my broken dsh sessions."*

## What it can fix

| Damage | Cause | Repair |
|---|---|---|
| Replayed duplicate rows | crash / force-kill / write-behind replay | drop duplicates — **zero loss** |
| Synthetic closer block colliding with the real continuation | interrupt recovery + second writer | drop the synthetic block, keep your real content — **zero loss** |
| Torn final zstd frame | power loss mid-write | none needed (dsh self-heals; we tell you so) |
| Unreadable/garbled header | manual edits, partial writes | header reconstruction |
| Real seq holes (events actually missing) | forced compaction, lost writes | explicit `--truncate` keeps the loadable prefix; `export` salvages the rest |

Both repair paths are pinned by regression tests modeled on the two corruption shapes reported in [deepseek-harness#1497](https://github.com/deepseek-ai/deepseek-harness/discussions/1497) (interrupt closers colliding with a resumed real tool result; a full tail rewritten from a recycled seq) — the tool's output matches the fixes those users validated by hand.

## Why it's safe

Community experience shows naive repairs can *kill* a session permanently (dangling `sourceEventSeqs` poisoning). This tool:

1. **Never touches the original without a timestamped backup** sitting right next to it.
2. **Validates before writing**: the rebuilt log must pass seq-contiguity and `sourceEventSeqs` reference checks — the same invariants dsh enforces. An unsafe plan is refused, not "fixed harder".
3. **Verifies after writing**: the repaired file is re-scanned; if it wouldn't load, the tool tells you and the backup is untouched.
4. **Preserves original bytes**: kept lines are copied verbatim, never re-serialized.
5. Rebuilds the exact physical layout dsh expects (zstd frame 0 = header only).

## vs. other tools

| | dsh-session-rescue | doctor-family tools | export-family tools |
|---|---|---|---|
| Detect corruption | ✅ | ✅ | — |
| **Repair the session so it loads & continues** | ✅ | ❌ | ❌ |
| Salvage transcript when unrepairable | ✅ | ❌ | ✅ |
| Refuses unsafe writes | ✅ | n/a | n/a |

## Scope & honesty

- Supports session format **version 0** (current dsh developer preview), `.jsonl` and `.jsonl.zstd`, JSONL backend only. dsh is pre-1.0 with no format-compatibility promise; on an unknown version this tool refuses loudly instead of guessing.
- Repair requires dsh to be **closed** (or at least that session idle) — a live writer would race the swap.
- Zero dependencies. Node ≥ 22.15 (built-in zstd).

## License

[MIT](LICENSE)
