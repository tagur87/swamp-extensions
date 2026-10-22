/**
 * Unit tests for the @tagur/zabbix model.
 *
 * These exercise every method against a mocked Zabbix JSON-RPC endpoint
 * (`withMockedFetch`), covering both the success path (data written) and the
 * failure path (API/HTTP errors and empty result sets propagate as throws
 * before anything is persisted).
 */
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";
import {
  createModelTestContext,
  withMockedFetch,
} from "jsr:@swamp-club/swamp-testing@0.20260706.24";
import { model } from "./zabbix.ts";

const ENDPOINT = "https://zabbix.example.com/zabbix/api_jsonrpc.php";

// createModelTestContext types globalArgs as Record<string, unknown>; the model
// annotates its context with the concrete GlobalArgs shape. They are
// structurally identical apart from that widening, so cast the seeded context
// to the type each execute() expects.
type MethodCtx = Parameters<typeof model.methods.server_info.execute>[1];

/** Build a MethodContext seeded with the standard global args. */
function ctx() {
  const c = createModelTestContext({
    globalArgs: {
      endpoint: ENDPOINT,
      token: "test-token",
      authStyle: "bearer",
    },
  });
  return { ...c, context: c.context as unknown as MethodCtx };
}

/** A successful JSON-RPC 2.0 envelope. */
function rpcOk(result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: 1, result });
}

/** A JSON-RPC 2.0 error envelope. */
function rpcErr(message: string, data?: string): Response {
  return Response.json({
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32602, message, data },
  });
}

/**
 * Route a JSON-RPC request to a canned response by its `method`, so a single
 * handler can satisfy the multi-call sequences in resolveItems()/trends().
 */
function router(
  responses: Record<string, (body: Record<string, unknown>) => Response>,
) {
  return async (req: Request): Promise<Response> => {
    const body = await req.json() as { method: string };
    const handler = responses[body.method];
    if (!handler) return rpcErr(`unexpected method ${body.method}`);
    return handler(body as Record<string, unknown>);
  };
}

// Shared fixtures. hostFilter ".*ra0.*" matches ra01/ra02 but not web01.
const HOST_GROUP = "Servers - Remote Access";
const GROUPS = [{ groupid: "2", name: HOST_GROUP }];
const HOSTS = [
  { hostid: "101", name: "ra01" },
  { hostid: "102", name: "ra02" },
  { hostid: "103", name: "web01" },
];
const ITEMS = [
  {
    itemid: "5001",
    name: "Concurrent Users",
    hostid: "101",
    value_type: "3",
    units: "",
    lastvalue: "42",
  },
  {
    itemid: "5002",
    name: "Concurrent Users",
    hostid: "102",
    value_type: "3",
    units: "",
    lastvalue: "37",
  },
];

// ── server_info ─────────────────────────────────────────────────────────────

Deno.test("server_info writes the Zabbix version", async () => {
  const { context, getWrittenResources } = ctx();
  const { result, calls } = await withMockedFetch(
    () => rpcOk("7.0.4"),
    () => model.methods.server_info.execute({}, context),
  );

  assertEquals(calls.length, 1);
  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "server");
  assertEquals(written[0].data.version, "7.0.4");
  assertEquals(written[0].data.endpoint, ENDPOINT);
  assertEquals(result.dataHandles.length, 1);
});

Deno.test("server_info propagates an API error and writes nothing", async () => {
  const { context, getWrittenResources } = ctx();
  await assertRejects(
    () =>
      withMockedFetch(
        () => rpcErr("apiinfo.version unavailable"),
        () => model.methods.server_info.execute({}, context),
      ),
    Error,
    "apiinfo.version unavailable",
  );
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("server_info surfaces a non-2xx HTTP status", async () => {
  const { context } = ctx();
  await assertRejects(
    () =>
      withMockedFetch(
        () => new Response("nope", { status: 502, statusText: "Bad Gateway" }),
        () => model.methods.server_info.execute({}, context),
      ),
    Error,
    "Zabbix HTTP 502",
  );
});

// ── discover ────────────────────────────────────────────────────────────────

Deno.test("discover lists regex-matched hosts and their items", async () => {
  const { context, getWrittenResources } = ctx();
  await withMockedFetch(
    router({
      "hostgroup.get": () => rpcOk(GROUPS),
      "host.get": () => rpcOk(HOSTS),
      "item.get": () => rpcOk(ITEMS),
    }),
    () =>
      model.methods.discover.execute({
        hostGroup: HOST_GROUP,
        hostFilter: ".*ra0.*",
        itemName: "Concurrent Users",
        match: "contains",
      }, context),
  );

  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "discovery");
  const data = written[0].data as {
    hosts: Array<{ host: string; items: unknown[] }>;
  };
  // web01 filtered out by the host regex.
  assertEquals(data.hosts.length, 2);
  assertEquals(data.hosts.map((h) => h.host).sort(), ["ra01", "ra02"]);
  assertEquals(data.hosts[0].items.length, 1);
});

Deno.test("discover throws when the host group is missing", async () => {
  const { context, getWrittenResources } = ctx();
  await assertRejects(
    () =>
      withMockedFetch(
        router({ "hostgroup.get": () => rpcOk([]) }),
        () =>
          model.methods.discover.execute({
            hostGroup: "Nonexistent",
            hostFilter: ".*",
            itemName: "Concurrent Users",
            match: "contains",
          }, context),
      ),
    Error,
    'No host group named "Nonexistent"',
  );
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("discover throws when no host matches the regex", async () => {
  const { context } = ctx();
  await assertRejects(
    () =>
      withMockedFetch(
        router({
          "hostgroup.get": () => rpcOk(GROUPS),
          "host.get": () => rpcOk(HOSTS),
        }),
        () =>
          model.methods.discover.execute({
            hostGroup: HOST_GROUP,
            hostFilter: "^does-not-match$",
            itemName: "Concurrent Users",
            match: "contains",
          }, context),
      ),
    Error,
    "matched",
  );
});

// ── trends ──────────────────────────────────────────────────────────────────

Deno.test("trends writes one series per host plus a summary", async () => {
  const { context, getWrittenResources } = ctx();
  await withMockedFetch(
    router({
      "hostgroup.get": () => rpcOk(GROUPS),
      "host.get": () => rpcOk(HOSTS),
      "item.get": () => rpcOk(ITEMS),
      "trend.get": () =>
        rpcOk([
          {
            itemid: "5001",
            clock: "1700000000",
            num: "6",
            value_min: "10",
            value_avg: "20",
            value_max: "40",
          },
          {
            itemid: "5001",
            clock: "1700003600",
            num: "6",
            value_min: "12",
            value_avg: "25",
            value_max: "45",
          },
          {
            itemid: "5002",
            clock: "1700000000",
            num: "6",
            value_min: "5",
            value_avg: "8",
            value_max: "12",
          },
        ]),
    }),
    () =>
      model.methods.trends.execute({
        hostGroup: HOST_GROUP,
        hostFilter: ".*ra0.*",
        itemName: "Concurrent Users",
        match: "exact",
        days: 30,
        source: "trends",
      }, context),
  );

  const written = getWrittenResources();
  const series = written.filter((w) => w.specName === "series");
  const summary = written.filter((w) => w.specName === "summary");
  assertEquals(series.length, 2);
  assertEquals(summary.length, 1);

  const ra01 = series.find((s) =>
    (s.data as { host: string }).host === "ra01"
  )!;
  assertEquals((ra01.data as { peak: number }).peak, 45);
  assertEquals((ra01.data as { points: unknown[] }).points.length, 2);

  const sum = summary[0].data as {
    hostCount: number;
    hosts: Array<{ host: string; peak: number }>;
  };
  assertEquals(sum.hostCount, 2);
  // Sorted by peak descending — ra01 (45) before ra02 (12).
  assertEquals(sum.hosts[0].host, "ra01");
  assertStringIncludes(summary[0].name, "concurrent-users");
});

Deno.test("trends throws when no items match", async () => {
  const { context, getWrittenResources } = ctx();
  await assertRejects(
    () =>
      withMockedFetch(
        router({
          "hostgroup.get": () => rpcOk(GROUPS),
          "host.get": () => rpcOk(HOSTS),
          "item.get": () => rpcOk([]),
        }),
        () =>
          model.methods.trends.execute({
            hostGroup: HOST_GROUP,
            hostFilter: ".*ra0.*",
            itemName: "No Such Item",
            match: "exact",
            days: 7,
            source: "trends",
          }, context),
      ),
    Error,
    "No items",
  );
  assertEquals(getWrittenResources().length, 0);
});
