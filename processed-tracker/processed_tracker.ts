/**
 * A tiny dedup ledger: remembers which ids a pipeline has already processed,
 * so repeat runs skip work already done. Backed entirely by swamp data — it
 * never touches any external system.
 *
 * Built for the OWA → Drive pipeline, where the id is an Exchange message
 * `ItemId`: the pipeline marks a message processed only AFTER its attachments
 * upload successfully, and `check` filters a fresh listing down to the ids not
 * yet seen. Keys are opaque strings, so it works for any id scheme.
 *
 * The whole ledger is one accumulating `ledger` resource per tracker `scope`
 * (default "default"), holding the set of processed ids. Methods operate on
 * LISTS so a workflow fans out in one call (repo rule 6) rather than looping.
 *
 *   - check : given candidate ids, return {newIds, knownIds} without mutating.
 *   - mark  : add ids to the ledger (idempotent; re-marking is a no-op).
 *   - list  : read the current ledger (count + ids).
 *   - forget: remove ids from the ledger (to force reprocessing).
 *
 * @module
 */
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  scope: z.string().min(1).default("default").describe(
    "Namespace for this ledger, so multiple pipelines can share one tracker " +
      "instance without colliding (e.g. 'owa-inbox').",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const LedgerSchema = z.object({
  scope: z.string(),
  ids: z.array(z.string()).describe("The set of processed ids."),
  count: z.number().int().nonnegative(),
  updatedAt: z.string(),
});

const CheckSchema = z.object({
  scope: z.string(),
  newIds: z.array(z.string()).describe("Candidates not yet in the ledger."),
  knownIds: z.array(z.string()).describe("Candidates already processed."),
  newCount: z.number().int().nonnegative(),
  knownCount: z.number().int().nonnegative(),
  checkedAt: z.string(),
});

interface MethodContext {
  globalArgs: GlobalArgs;
  signal: AbortSignal;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  // Reads the latest stored content of this behaviour's own data by INSTANCE
  // name (the name passed to writeResource), or null if none exists yet.
  readResource?: (
    instanceName: string,
  ) => Promise<Record<string, unknown> | null>;
}

/** Deterministic resource name for a scope's ledger. */
function ledgerName(scope: string): string {
  return `ledger-${scope.replace(/[^A-Za-z0-9_.-]+/g, "-")}`;
}

/**
 * Read the current set of processed ids for the scope from this behaviour's own
 * prior `ledger` data (by instance name), falling back to empty on first run.
 */
async function readLedger(
  context: MethodContext,
  scope: string,
): Promise<Set<string>> {
  const name = ledgerName(scope);
  let stored: Record<string, unknown> | null = null;
  try {
    if (context.readResource) {
      stored = await context.readResource(name);
    }
  } catch {
    stored = null;
  }
  const raw = stored?.["ids"];
  const ids = Array.isArray(raw) ? raw as unknown[] : [];
  return new Set(ids.filter((x): x is string => typeof x === "string"));
}

async function writeLedger(
  context: MethodContext,
  scope: string,
  ids: Set<string>,
): Promise<{ name: string }> {
  const sorted = [...ids].sort();
  return await context.writeResource("ledger", ledgerName(scope), {
    scope,
    ids: sorted,
    count: sorted.length,
    updatedAt: new Date().toISOString(),
  });
}

/** A swamp-data dedup ledger keyed on opaque ids. */
export const model = {
  type: "@tagur/processed-tracker",
  version: "2026.10.26.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    "ledger": {
      description: "The accumulating set of processed ids for a scope.",
      schema: LedgerSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "check": {
      description: "Result of a check: which candidate ids are new vs known.",
      schema: CheckSchema,
      lifetime: "1h" as const,
      garbageCollection: 20,
    },
  },

  methods: {
    "check": {
      description:
        "Partition candidate ids into newIds (not yet processed) and knownIds " +
        "(already in the ledger), without mutating. The pipeline processes " +
        "only newIds. Pass all candidate ids at once.",
      arguments: z.object({
        ids: z.array(z.string()).describe("Candidate ids to check."),
      }),
      execute: async (args: { ids: string[] }, context: MethodContext) => {
        const scope = context.globalArgs.scope;
        const known = await readLedger(context, scope);
        const newIds: string[] = [];
        const knownIds: string[] = [];
        for (const id of args.ids) {
          (known.has(id) ? knownIds : newIds).push(id);
        }
        context.logger.info(
          "Checked {total}: {newN} new, {knownN} already processed",
          {
            total: args.ids.length,
            newN: newIds.length,
            knownN: knownIds.length,
          },
        );
        const handle = await context.writeResource("check", `check-${scope}`, {
          scope,
          newIds,
          knownIds,
          newCount: newIds.length,
          knownCount: knownIds.length,
          checkedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "mark": {
      description:
        "Add ids to the ledger (call AFTER their work succeeds). Idempotent — " +
        "re-marking an id is a no-op. Pass all newly-processed ids at once.",
      arguments: z.object({
        ids: z.array(z.string()).describe("Ids to record as processed."),
      }),
      execute: async (args: { ids: string[] }, context: MethodContext) => {
        const scope = context.globalArgs.scope;
        const set = await readLedger(context, scope);
        let added = 0;
        for (const id of args.ids) {
          if (!set.has(id)) {
            set.add(id);
            added++;
          }
        }
        context.logger.info("Marked {added} new id(s); ledger now {total}", {
          added,
          total: set.size,
        });
        const handle = await writeLedger(context, scope, set);
        return { dataHandles: [handle] };
      },
    },

    "list": {
      description:
        "Read the current ledger: the count and set of processed ids.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const scope = context.globalArgs.scope;
        const set = await readLedger(context, scope);
        const handle = await writeLedger(context, scope, set);
        return { dataHandles: [handle] };
      },
    },

    "forget": {
      description:
        "Remove ids from the ledger so they are reprocessed next run. Pass an " +
        "empty list to no-op, or the ids to drop.",
      arguments: z.object({
        ids: z.array(z.string()).describe("Ids to remove from the ledger."),
      }),
      execute: async (args: { ids: string[] }, context: MethodContext) => {
        const scope = context.globalArgs.scope;
        const set = await readLedger(context, scope);
        let removed = 0;
        for (const id of args.ids) {
          if (set.delete(id)) removed++;
        }
        context.logger.info("Forgot {removed} id(s); ledger now {total}", {
          removed,
          total: set.size,
        });
        const handle = await writeLedger(context, scope, set);
        return { dataHandles: [handle] };
      },
    },
  },
};
