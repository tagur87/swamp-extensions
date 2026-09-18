/**
 * Unit tests for the @tagur/meraki model.
 *
 * @module
 */
import {
  createModelTestContext,
  withMockedFetch,
} from "jsr:@swamp-club/swamp-testing@0.20260706.24";
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./meraki.ts";

/** Global arguments with every default filled in, as the runtime would. */
function globalArgs(overrides: Record<string, unknown> = {}) {
  return {
    profiles: {
      corp: { apiKey: "key-corp", organizationId: "111" },
      lab: { apiKey: "key-lab", organizationId: "222" },
    },
    baseUrl: "https://api.meraki.com/api/v1",
    perPage: 1000,
    maxPages: 50,
    maxRetries: 4,
    includeLicenseKeys: false,
    ...overrides,
  };
}

/** Just the `corp` profile, for tests that do not need the fan-out. */
function corpOnly(overrides: Record<string, unknown> = {}) {
  return { profiles: { corp: globalArgs().profiles.corp }, ...overrides };
}

/**
 * Method context shape the model's execute functions accept.
 *
 * The harness types `globalArgs` as `Record<string, unknown>`, so the context
 * is re-typed here rather than loosening the model's own signatures.
 */
type SyncCtx = Parameters<typeof model.methods.sync_devices.execute>[1];

/**
 * Build a test context whose logger exposes `warning`.
 *
 * The swamp runtime's logger has `warning` (verified against a live method
 * run); the testing package only declares `warn`, so the alias keeps captured
 * warnings flowing through `getLogs()` at the `warning` level.
 */
function testContext(overrides: Record<string, unknown> = {}) {
  const harness = createModelTestContext({ globalArgs: globalArgs(overrides) });
  const logger = harness.context.logger;
  const context = {
    ...harness.context,
    logger: Object.assign({}, logger, {
      warning: (msg: string, props?: Record<string, unknown>) =>
        logger.warn(msg, props),
    }),
  } as unknown as SyncCtx;
  return { ...harness, context };
}

/** JSON response helper with an optional Link header. */
function json(body: unknown, link?: string): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (link) headers.Link = link;
  return new Response(JSON.stringify(body), { status: 200, headers });
}

Deno.test("sync_devices fans out over profiles and injects origin fields", async () => {
  const { context, getWrittenResources } = testContext();
  const keysSeen: string[] = [];

  await withMockedFetch((req: Request) => {
    keysSeen.push(req.headers.get("Authorization") ?? "");
    const org = new URL(req.url).pathname.includes("/111/") ? "111" : "222";
    return json([{ serial: `Q2-${org}`, name: `ap-${org}`, model: "MR46" }]);
  }, async () => {
    await model.methods.sync_devices.execute({}, context);
  });

  assertEquals(keysSeen, ["Bearer key-corp", "Bearer key-lab"]);

  const devices = getWrittenResources().filter((r) => r.specName === "device");
  assertEquals(devices.length, 2);
  assertEquals(devices[0].name, "device-corp-q2-111");
  assertEquals(devices[0].data.profile, "corp");
  assertEquals(devices[0].data.organizationId, "111");
  assertEquals(devices[1].data.profile, "lab");
  assertEquals(devices[1].data.organizationId, "222");
  // Passthrough keeps fields the schema does not declare explicitly.
  assertEquals(devices[0].data.model, "MR46");

  const snapshots = getWrittenResources().filter((r) =>
    r.specName === "snapshot"
  );
  assertEquals(snapshots.length, 2);
  assertEquals(snapshots[0].name, "snapshot-sync-devices-corp");
  assertEquals(snapshots[0].data.method, "sync_devices");
  assertEquals(snapshots[0].data.count, 1);
  assertEquals(snapshots[0].data.truncated, false);
  assertEquals(snapshots[0].data.errors, []);
  assertEquals(snapshots[0].data.organizationIds, ["111"]);
});

Deno.test("sync_devices follows Link rel=next pagination", async () => {
  const { context, getWrittenResources } = testContext(corpOnly());
  let page = 0;

  await withMockedFetch(() => {
    page++;
    if (page === 1) {
      return json(
        [{ serial: "Q2-A" }],
        '<https://api.meraki.com/api/v1/organizations/111/devices?perPage=1000&startingAfter=Q2-A>; rel="next"',
      );
    }
    return json([{ serial: "Q2-B" }]);
  }, async () => {
    await model.methods.sync_devices.execute({}, context);
  });

  assertEquals(page, 2);
  const devices = getWrittenResources().filter((r) => r.specName === "device");
  assertEquals(devices.map((d) => d.data.serial), ["Q2-A", "Q2-B"]);
  const snapshot = getWrittenResources().find((r) =>
    r.specName === "snapshot"
  )!;
  assertEquals(snapshot.data.count, 2);
  assertEquals(snapshot.data.truncated, false);
  assertEquals(snapshot.data.requests, 2);
});

Deno.test("sync_devices reports truncation when the page cap is hit", async () => {
  const { context, getWrittenResources } = testContext(
    corpOnly({ maxPages: 1 }),
  );

  await withMockedFetch(
    () =>
      json(
        [{ serial: "Q2-A" }],
        "<https://api.meraki.com/api/v1/organizations/111/devices?startingAfter=Q2-A>; rel=next",
      ),
    async () => {
      await model.methods.sync_devices.execute({}, context);
    },
  );

  const snapshot = getWrittenResources().find((r) =>
    r.specName === "snapshot"
  )!;
  assertEquals(snapshot.data.truncated, true);
  assertEquals(snapshot.data.count, 1);
});

Deno.test("array filters become repeated bracket parameters", async () => {
  const { context } = testContext(corpOnly());
  let requested = "";

  await withMockedFetch((req: Request) => {
    requested = req.url;
    return json([]);
  }, async () => {
    await model.methods.sync_devices.execute(
      { productTypes: ["appliance", "switch"] },
      context,
    );
  });

  const params = new URL(requested).searchParams.getAll("productTypes[]");
  assertEquals(params, ["appliance", "switch"]);
});

Deno.test("rate-limited responses are retried honoring Retry-After", async () => {
  const { context, getWrittenResources, getLogsByLevel } = testContext(
    corpOnly(),
  );
  let attempts = 0;

  await withMockedFetch(() => {
    attempts++;
    if (attempts === 1) {
      return new Response("API rate limit exceeded for organization", {
        status: 429,
        headers: { "Retry-After": "0" },
      });
    }
    return json([{ serial: "Q2-A" }]);
  }, async () => {
    await model.methods.sync_devices.execute({}, context);
  });

  assertEquals(attempts, 2);
  assertEquals(
    getWrittenResources().filter((r) => r.specName === "device").length,
    1,
  );
  assert(
    getLogsByLevel("warning").some((l) => l.message.includes("retrying")),
    "expected a retry warning",
  );
});

Deno.test("permanent errors are not retried and surface the status", async () => {
  const { context } = testContext(corpOnly());
  let attempts = 0;

  await withMockedFetch(() => {
    attempts++;
    return new Response("Missing API key", { status: 401 });
  }, async () => {
    const err = await assertRejects(() =>
      model.methods.sync_devices.execute({}, context)
    );
    assert(
      (err as Error).message.includes("401"),
      `expected 401 in message, got: ${(err as Error).message}`,
    );
  });

  assertEquals(attempts, 1);
});

Deno.test("a failing profile does not discard the profile that succeeded", async () => {
  const { context, getWrittenResources } = testContext();

  await withMockedFetch((req: Request) => {
    if (new URL(req.url).pathname.includes("/222/")) {
      return new Response("This organization does not support licensing", {
        status: 400,
      });
    }
    return json([{ id: "lic-1", licenseType: "MR ENT" }]);
  }, async () => {
    await model.methods.sync_licenses.execute({}, context);
  });

  const licenses = getWrittenResources().filter((r) =>
    r.specName === "license"
  );
  assertEquals(licenses.length, 1);
  assertEquals(licenses[0].data.profile, "corp");

  const snapshots = getWrittenResources().filter((r) =>
    r.specName === "snapshot"
  );
  assertEquals(snapshots.length, 2);
  const lab = snapshots.find((s) => s.data.profile === "lab")!;
  assertEquals(lab.data.count, 0);
  assertEquals((lab.data.errors as string[]).length, 1);
  assert(
    (lab.data.errors as string[])[0].includes("400"),
    "expected the org error to carry the HTTP status",
  );
});

Deno.test("a run that produces nothing at all throws", async () => {
  const { context } = testContext();

  await withMockedFetch(
    () => new Response("Forbidden", { status: 403 }),
    async () => {
      const err = await assertRejects(() =>
        model.methods.sync_licenses.execute({}, context)
      );
      assert(
        (err as Error).message.includes("produced no data"),
        `unexpected message: ${(err as Error).message}`,
      );
    },
  );
});

Deno.test("license keys are withheld unless explicitly enabled", async () => {
  const withheld = testContext(corpOnly());
  const included = testContext(corpOnly({ includeLicenseKeys: true }));

  const respond = () => json([{ id: "lic-1", licenseKey: "Z2-SECRET" }]);

  await withMockedFetch(respond, async () => {
    await model.methods.sync_licenses.execute({}, withheld.context);
  });
  await withMockedFetch(respond, async () => {
    await model.methods.sync_licenses.execute({}, included.context);
  });

  const a = withheld.getWrittenResources().find((r) =>
    r.specName === "license"
  )!;
  assertEquals(a.data.licenseKey, undefined);
  const b = included.getWrittenResources().find((r) =>
    r.specName === "license"
  )!;
  assertEquals(b.data.licenseKey, "Z2-SECRET");
});

Deno.test("an unknown profile name fails loudly", async () => {
  const { context } = testContext();
  const err = await assertRejects(() =>
    model.methods.sync_devices.execute({ profile: "staging" }, context)
  );
  assert(
    (err as Error).message.includes("Unknown profile"),
    `unexpected message: ${(err as Error).message}`,
  );
});

Deno.test("naming a profile limits the fan-out to that profile", async () => {
  const { context, getWrittenResources } = testContext();

  await withMockedFetch(
    () => json([{ id: "N_1", name: "HQ" }]),
    async () => {
      await model.methods.sync_networks.execute({ profile: "lab" }, context);
    },
  );

  const networks = getWrittenResources().filter((r) =>
    r.specName === "network"
  );
  assertEquals(networks.length, 1);
  assertEquals(networks[0].data.profile, "lab");
  assertEquals(
    getWrittenResources().filter((r) => r.specName === "snapshot").length,
    1,
  );
});

Deno.test("sync_clients tags each client with its network", async () => {
  const { context, getWrittenResources } = testContext(corpOnly());
  const paths: string[] = [];

  await withMockedFetch((req: Request) => {
    paths.push(new URL(req.url).pathname);
    return json([{ id: "k1", mac: "00:11:22:33:44:55" }]);
  }, async () => {
    await model.methods.sync_clients.execute(
      { networkIds: ["N_1", "N_2"], timespan: 3600 },
      context,
    );
  });

  assertEquals(paths, [
    "/api/v1/networks/N_1/clients",
    "/api/v1/networks/N_2/clients",
  ]);
  const clients = getWrittenResources().filter((r) => r.specName === "client");
  assertEquals(clients.map((c) => c.data.networkId), ["N_1", "N_2"]);
  assertEquals(clients.map((c) => c.name), [
    "client-corp-n-1-k1",
    "client-corp-n-2-k1",
  ]);
});

Deno.test("sync_organizations discovers orgs when none is pinned", async () => {
  const { context, getWrittenResources } = testContext({
    profiles: { corp: { apiKey: "key-corp" } },
  });

  await withMockedFetch(
    () => json([{ id: "111", name: "Corp" }, { id: "999", name: "Other" }]),
    async () => {
      await model.methods.sync_organizations.execute({}, context);
    },
  );

  const orgs = getWrittenResources().filter((r) =>
    r.specName === "organization"
  );
  assertEquals(orgs.map((o) => o.data.id), ["111", "999"]);
  const snapshot = getWrittenResources().find((r) =>
    r.specName === "snapshot"
  )!;
  assertEquals(snapshot.data.organizationIds, ["111", "999"]);
});

Deno.test("request substitutes {organizationId} and stores the raw body", async () => {
  const { context, getWrittenResources } = testContext(corpOnly());
  let requested = "";

  await withMockedFetch((req: Request) => {
    requested = new URL(req.url).pathname;
    return json({ name: "HQ", id: "N_1" });
  }, async () => {
    await model.methods.request.execute({
      path: "organizations/{organizationId}/admins",
      paginate: false,
    }, context);
  });

  assertEquals(requested, "/api/v1/organizations/111/admins");
  const response = getWrittenResources().find((r) =>
    r.specName === "response"
  )!;
  assertEquals(response.data.path, "organizations/111/admins");
  assertEquals(response.data.status, 200);
  assertEquals(response.data.truncated, false);
  assertEquals(response.data.body, { name: "HQ", id: "N_1" });
});

Deno.test("request writes nothing when any profile fails", async () => {
  const { context, getWrittenResources } = testContext();

  await withMockedFetch((req: Request) => {
    if (new URL(req.url).pathname.includes("/222/")) {
      return new Response("Forbidden", { status: 403 });
    }
    return json({ ok: true });
  }, async () => {
    await assertRejects(() =>
      model.methods.request.execute({
        path: "organizations/{organizationId}/admins",
        paginate: false,
      }, context)
    );
  });

  assertEquals(getWrittenResources().length, 0);
});

Deno.test("profiles-configured check rejects an empty key", async () => {
  const empty = await model.checks["profiles-configured"].execute({
    globalArgs: globalArgs({ profiles: { corp: { apiKey: "   " } } }),
  });
  assertEquals(empty.pass, false);
  assert(empty.errors![0].includes("corp"));

  const none = await model.checks["profiles-configured"].execute({
    globalArgs: globalArgs({ profiles: {} }),
  });
  assertEquals(none.pass, false);

  const ok = await model.checks["profiles-configured"].execute({
    globalArgs: globalArgs(),
  });
  assertEquals(ok.pass, true);
});

Deno.test("api-reachable check reports the profile that failed", async () => {
  const { context } = testContext();

  await withMockedFetch((req: Request) => {
    if (req.headers.get("Authorization") === "Bearer key-lab") {
      return new Response("Missing API key", { status: 401 });
    }
    return json([{ id: "111", name: "Corp" }]);
  }, async () => {
    const result = await model.checks["api-reachable"].execute({
      globalArgs: globalArgs(),
      logger: context.logger,
    });
    assertEquals(result.pass, false);
    assertEquals(result.errors!.length, 1);
    assert(result.errors![0].startsWith('Profile "lab"'));
  });
});

Deno.test("errors and logs never carry the API key", async () => {
  const { context, getLogs } = testContext(corpOnly());

  await withMockedFetch(
    () => new Response("nope", { status: 401 }),
    async () => {
      const err = await assertRejects(() =>
        model.methods.sync_devices.execute({}, context)
      );
      assert(
        !(err as Error).message.includes("key-corp"),
        "API key leaked into the error message",
      );
    },
  );

  const serialized = JSON.stringify(getLogs());
  assert(!serialized.includes("key-corp"), "API key leaked into logs");
});
