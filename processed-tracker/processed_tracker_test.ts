/**
 * Unit tests for the @tagur/processed-tracker model.
 *
 * The ledger lives in swamp data; the test harness captures writes and lets us
 * feed a prior `readResource` value, so the check/mark/forget logic is tested
 * without any real datastore. Covers both the first-run (empty ledger) path and
 * the populated-ledger path.
 *
 * @module
 */
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260706.24";
import { assertEquals } from "jsr:@std/assert@1.0.19";
import { model } from "./processed_tracker.ts";

type Ctx = Parameters<typeof model.methods.check.execute>[1];

/**
 * Build a method context whose readResource returns a ledger with `priorIds`
 * (or null to simulate the first run), and that captures the data written.
 */
function ctxWith(priorIds: string[] | null): {
  context: Ctx;
  written: Array<{ spec: string; name: string; data: Record<string, unknown> }>;
} {
  const harness = createModelTestContext({ globalArgs: { scope: "test" } });
  const written: Array<
    { spec: string; name: string; data: Record<string, unknown> }
  > = [];
  const context = {
    ...harness.context,
    readResource: (_instanceName: string) =>
      Promise.resolve(
        priorIds === null ? null : { scope: "test", ids: priorIds },
      ),
    writeResource: (
      spec: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      written.push({ spec, name, data });
      return Promise.resolve({ name });
    },
  } as unknown as Ctx;
  return { context, written };
}

Deno.test("check: first run (empty ledger) — all ids are new", async () => {
  const { context, written } = ctxWith(null);
  await model.methods.check.execute({ ids: ["a", "b", "c"] }, context);
  const rec = written[0].data;
  assertEquals(rec.newIds, ["a", "b", "c"]);
  assertEquals(rec.knownIds, []);
  assertEquals(rec.newCount, 3);
  assertEquals(rec.knownCount, 0);
});

Deno.test("check: partitions against a populated ledger", async () => {
  const { context, written } = ctxWith(["a", "b"]);
  await model.methods.check.execute({ ids: ["a", "b", "c", "d"] }, context);
  const rec = written[0].data;
  assertEquals(rec.newIds, ["c", "d"]);
  assertEquals(rec.knownIds, ["a", "b"]);
});

Deno.test("check: empty candidate list yields empty partitions", async () => {
  const { context, written } = ctxWith(["a"]);
  await model.methods.check.execute({ ids: [] }, context);
  const rec = written[0].data;
  assertEquals(rec.newIds, []);
  assertEquals(rec.knownIds, []);
});

Deno.test("mark: adds new ids and is idempotent on re-mark", async () => {
  const { context, written } = ctxWith(["a"]);
  await model.methods.mark.execute({ ids: ["a", "b", "c"] }, context);
  const rec = written[0].data;
  // "a" already present; b,c added. Stored sorted.
  assertEquals(rec.ids, ["a", "b", "c"]);
  assertEquals(rec.count, 3);
});

Deno.test("mark: first run writes exactly the marked ids", async () => {
  const { context, written } = ctxWith(null);
  await model.methods.mark.execute({ ids: ["x", "y"] }, context);
  assertEquals(written[0].data.ids, ["x", "y"]);
  assertEquals(written[0].data.count, 2);
});

Deno.test("forget: removes ids and leaves the rest", async () => {
  const { context, written } = ctxWith(["a", "b", "c"]);
  await model.methods.forget.execute({ ids: ["b"] }, context);
  assertEquals(written[0].data.ids, ["a", "c"]);
  assertEquals(written[0].data.count, 2);
});

Deno.test("forget: removing an absent id is a no-op", async () => {
  const { context, written } = ctxWith(["a"]);
  await model.methods.forget.execute({ ids: ["zzz"] }, context);
  assertEquals(written[0].data.ids, ["a"]);
});

Deno.test("list: reports the current ledger unchanged", async () => {
  const { context, written } = ctxWith(["a", "b"]);
  await model.methods.list.execute({}, context);
  assertEquals(written[0].data.ids, ["a", "b"]);
  assertEquals(written[0].data.count, 2);
});
