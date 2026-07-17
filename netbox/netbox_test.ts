/**
 * Unit tests for the @tagur/netbox model.
 *
 * Exercises sync and get methods against a mocked NetBox REST API
 * (`withMockedFetch`), covering success paths, pagination, error handling,
 * and edge cases identified during adversarial review.
 */
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import {
  createModelTestContext,
  withMockedFetch,
} from "jsr:@swamp-club/swamp-testing";
import { model } from "./netbox.ts";

const BASE_URL = "https://nsot.example.com";
const ENDPOINT = "dcim/sites";

type SyncCtx = Parameters<typeof model.methods.sync.execute>[1];
type GetCtx = Parameters<typeof model.methods.get.execute>[1];

function ctx() {
  const c = createModelTestContext({
    globalArgs: {
      url: BASE_URL,
      token: "test-token",
      endpoint: ENDPOINT,
      pageSize: 50,
    },
  });
  return { ...c, context: c.context as unknown as SyncCtx };
}

function getCtx() {
  const c = createModelTestContext({
    globalArgs: {
      url: BASE_URL,
      token: "test-token",
      endpoint: ENDPOINT,
      pageSize: 50,
    },
  });
  return { ...c, context: c.context as unknown as GetCtx };
}

function netboxPage(
  results: Record<string, unknown>[],
  count: number,
  next: string | null = null,
): Response {
  return Response.json({ count, next, results });
}

const SITES = [
  { id: 1, url: "https://nsot.example.com/api/dcim/sites/1/", display: "New York", name: "New York", slug: "new-york", status: { value: "active" } },
  { id: 2, url: "https://nsot.example.com/api/dcim/sites/2/", display: "London", name: "London", slug: "london", status: { value: "active" } },
  { id: 3, url: "https://nsot.example.com/api/dcim/sites/3/", display: "Tokyo", name: "Tokyo", slug: "tokyo", status: { value: "planned" } },
];

// ── sync: basic ─────────────────────────────────────────────────────────────

Deno.test("sync writes one item per object plus a snapshot", async () => {
  const { context, getWrittenResources } = ctx();
  await withMockedFetch(
    () => netboxPage(SITES, 3),
    () => model.methods.sync.execute({}, context),
  );

  const written = getWrittenResources();
  const items = written.filter((w) => w.specName === "item");
  const snapshots = written.filter((w) => w.specName === "snapshot");
  assertEquals(items.length, 3);
  assertEquals(snapshots.length, 1);
  assertEquals(snapshots[0].data.count, 3);
  assertEquals((snapshots[0].data.itemIds as number[]).sort(), [1, 2, 3]);
});

Deno.test("sync uses slug + id in instance names (collision-safe)", async () => {
  const { context, getWrittenResources } = ctx();
  await withMockedFetch(
    () => netboxPage(SITES, 3),
    () => model.methods.sync.execute({}, context),
  );

  const items = getWrittenResources().filter((w) => w.specName === "item");
  const names = items.map((w) => w.name);
  assertEquals(names.includes("dcim-sites-new-york-1"), true);
  assertEquals(names.includes("dcim-sites-london-2"), true);
  assertEquals(names.includes("dcim-sites-tokyo-3"), true);
});

// ── sync: pagination ────────────────────────────────────────────────────────

Deno.test("sync follows pagination via next links", async () => {
  const { context, getWrittenResources } = ctx();
  let callCount = 0;

  await withMockedFetch(
    () => {
      callCount++;
      if (callCount === 1) {
        return netboxPage(
          [SITES[0], SITES[1]],
          3,
          `${BASE_URL}/api/dcim/sites/?limit=2&offset=2`,
        );
      }
      return netboxPage([SITES[2]], 3);
    },
    () => model.methods.sync.execute({}, context),
  );

  assertEquals(callCount, 2);
  const items = getWrittenResources().filter((w) => w.specName === "item");
  assertEquals(items.length, 3);
});

// ── sync: filters ───────────────────────────────────────────────────────────

Deno.test("sync merges method filters over global filters", async () => {
  const c = createModelTestContext({
    globalArgs: {
      url: BASE_URL,
      token: "test-token",
      endpoint: ENDPOINT,
      pageSize: 50,
      filters: { region: "amer", status: "active" },
    },
  });
  const context = c.context as unknown as SyncCtx;
  let capturedUrl = "";

  await withMockedFetch(
    (req: Request) => {
      capturedUrl = req.url;
      return netboxPage([], 0);
    },
    () => model.methods.sync.execute({ filters: { status: "planned" } }, context),
  );

  const url = new URL(capturedUrl);
  assertEquals(url.searchParams.get("region"), "amer");
  assertEquals(url.searchParams.get("status"), "planned");
});

Deno.test("sync with different filters produces distinct snapshot names", async () => {
  const { context: ctx1, getWrittenResources: get1 } = ctx();
  const { context: ctx2, getWrittenResources: get2 } = ctx();

  await withMockedFetch(
    () => netboxPage([], 0),
    () => model.methods.sync.execute({ filters: { status: "active" } }, ctx1),
  );
  await withMockedFetch(
    () => netboxPage([], 0),
    () => model.methods.sync.execute({ filters: { status: "planned" } }, ctx2),
  );

  const snap1 = get1().find((w) => w.specName === "snapshot")!;
  const snap2 = get2().find((w) => w.specName === "snapshot")!;
  // Different filter values should produce different snapshot names.
  assertEquals(snap1.name !== snap2.name, true);
  assertStringIncludes(snap1.name, "active");
  assertStringIncludes(snap2.name, "planned");
});

// ── sync: empty result set ──────────────────────────────────────────────────

Deno.test("sync with zero results still writes a snapshot", async () => {
  const { context, getWrittenResources } = ctx();
  await withMockedFetch(
    () => netboxPage([], 0),
    () => model.methods.sync.execute({}, context),
  );

  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "snapshot");
  assertEquals(written[0].data.count, 0);
});

// ── sync: API errors ────────────────────────────────────────────────────────

Deno.test("sync propagates a non-2xx API error", async () => {
  const { context, getWrittenResources } = ctx();
  await assertRejects(
    () =>
      withMockedFetch(
        () => new Response("Forbidden", { status: 403, statusText: "Forbidden" }),
        () => model.methods.sync.execute({}, context),
      ),
    Error,
    "403",
  );
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("sync truncates large error bodies", async () => {
  const { context } = ctx();
  const largeBody = "x".repeat(2000);
  try {
    await withMockedFetch(
      () => new Response(largeBody, { status: 500, statusText: "Internal Server Error" }),
      () => model.methods.sync.execute({}, context),
    );
  } catch (err) {
    assertStringIncludes((err as Error).message, "truncated");
    assertEquals((err as Error).message.length < 1000, true);
  }
});

// ── sync: objects without slug or name ──────────────────────────────────────

Deno.test("sync handles objects with no slug or name (id-only naming)", async () => {
  const { context, getWrittenResources } = ctx();
  const objects = [
    { id: 99 },
    { id: 100, name: "Has Name" },
  ];

  await withMockedFetch(
    () => netboxPage(objects, 2),
    () => model.methods.sync.execute({}, context),
  );

  const items = getWrittenResources().filter((w) => w.specName === "item");
  const names = items.map((w) => w.name);
  assertEquals(names.includes("dcim-sites-99"), true);
  assertEquals(names.includes("dcim-sites-has-name-100"), true);
});

// ── get: basic ──────────────────────────────────────────────────────────────

Deno.test("get fetches a single object by ID", async () => {
  const { context, getWrittenResources } = getCtx();
  await withMockedFetch(
    () => Response.json(SITES[0]),
    () => model.methods.get.execute({ id: 1 }, context),
  );

  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "item");
  assertEquals(written[0].data.slug, "new-york");
  assertEquals(written[0].name, "dcim-sites-new-york-1");
});

Deno.test("get propagates a 404 error", async () => {
  const { context, getWrittenResources } = getCtx();
  await assertRejects(
    () =>
      withMockedFetch(
        () => new Response("Not Found", { status: 404, statusText: "Not Found" }),
        () => model.methods.get.execute({ id: 99999 }, context),
      ),
    Error,
    "404",
  );
  assertEquals(getWrittenResources().length, 0);
});

// ── get: authorization header ───────────────────────────────────────────────

Deno.test("get sends Token authorization header", async () => {
  const { context } = getCtx();
  let capturedAuth = "";

  await withMockedFetch(
    (req: Request) => {
      capturedAuth = req.headers.get("Authorization") ?? "";
      return Response.json(SITES[0]);
    },
    () => model.methods.get.execute({ id: 1 }, context),
  );

  assertEquals(capturedAuth, "Token test-token");
});

// ── checks: api-reachable ───────────────────────────────────────────────────

type CheckCtx = Parameters<typeof model.checks["api-reachable"]["execute"]>[0];

Deno.test("api-reachable check passes on 200", async () => {
  const c = createModelTestContext({
    globalArgs: {
      url: BASE_URL,
      token: "test-token",
      endpoint: ENDPOINT,
      pageSize: 50,
    },
  });
  const checkCtx = c.context as unknown as CheckCtx;

  const { result } = await withMockedFetch(
    () => netboxPage([], 0),
    () => model.checks["api-reachable"].execute(checkCtx),
  );

  assertEquals(result.pass, true);
});

Deno.test("api-reachable check fails on non-2xx", async () => {
  const c = createModelTestContext({
    globalArgs: {
      url: BASE_URL,
      token: "bad-token",
      endpoint: ENDPOINT,
      pageSize: 50,
    },
  });
  const checkCtx = c.context as unknown as CheckCtx;

  const { result } = await withMockedFetch(
    () => new Response("Unauthorized", { status: 401, statusText: "Unauthorized" }),
    () => model.checks["api-reachable"].execute(checkCtx),
  );

  assertEquals(result.pass, false);
  assertStringIncludes(result.errors![0], "401");
});
