# @tagur/processed-tracker

A tiny dedup ledger for swamp pipelines. Remember which ids you have already
processed, so repeat runs skip the work already done — without touching any
external system.

- **Swamp-data backed.** The ledger is a versioned swamp data resource. No
  database, no files, no external calls.
- **Opaque keys.** Ids are arbitrary strings: message ids, file hashes, record
  ids, URLs — anything that uniquely names a unit of work.
- **Scoped.** Each tracker instance has a `scope`, so several pipelines can
  share one instance without their ledgers colliding.
- **List-oriented.** Every method takes or returns a list, so a workflow fans
  out in a single call instead of looping one id at a time.

## Quick start

```bash
swamp extension pull @tagur/processed-tracker

# One instance per logical pipeline.
swamp behavior create @tagur/processed-tracker dedup --global-arg scope=my-pipeline
```

## The dedup loop

The intended pattern, in a workflow:

1. **`list`** (or `check`) to learn what has already been processed.
2. Do the work for the new ids only.
3. **`mark`** the ids you finished — *after* the work succeeds, so a failure
   leaves them unmarked and the next run retries them.

```bash
# Partition candidates: which are new vs already done (non-mutating).
swamp behavior run dedup check --arg 'ids=["msg-1","msg-2","msg-3"]'
# -> writes a `check` resource: { newIds: [...], knownIds: [...] }

# After successfully processing the new ones, record them.
swamp behavior run dedup mark --arg 'ids=["msg-1","msg-2"]'

# Inspect the ledger at any time.
swamp behavior run dedup list

# Force reprocessing of specific ids.
swamp behavior run dedup forget --arg 'ids=["msg-1"]'
```

## Methods

| Method   | Arguments     | Purpose                                                        |
| -------- | ------------- | -------------------------------------------------------------- |
| `check`  | `ids: []`     | Partition into `newIds` / `knownIds`. Does **not** mutate.     |
| `mark`   | `ids: []`     | Add ids to the ledger. Idempotent; call after work succeeds.   |
| `list`   | —             | Read the current ledger (`count` + `ids`).                     |
| `forget` | `ids: []`     | Remove ids so they are reprocessed next run.                   |

## Global arguments

| Argument | Default     | Description                                               |
| -------- | ----------- | --------------------------------------------------------- |
| `scope`  | `"default"` | Namespace for this ledger. Use one per logical pipeline.  |

## Data

- **`ledger`** — the accumulating set of processed ids for a scope
  (`scope`, `ids`, `count`, `updatedAt`). One instance per scope.
- **`check`** — the most recent `check` result (`newIds`, `knownIds`, counts).

Read them with CEL, e.g. in a workflow step:
`${{ data.latest("dedup", "ledger-my-pipeline").content.ids }}`.

## Wiring into a workflow

`check`/`list` runs before the work; `mark` runs after, gated on the work
succeeding, so nothing is marked done unless it actually finished:

```yaml
- name: read-ledger
  task: { type: model_method, modelIdOrName: dedup, methodName: list }
- name: do-work
  # ... skip ids in data.latest("dedup","ledger-my-pipeline").content.ids ...
  dependsOn: [{ step: read-ledger, condition: { type: succeeded } }]
- name: mark-done
  task:
    type: model_method
    modelIdOrName: dedup
    methodName: mark
    inputs:
      ids: ${{ data.latest("do-work", "...").content.processedIds }}
  dependsOn: [{ step: do-work, condition: { type: succeeded } }]
```

## License

MIT
