/**
 * Unit tests for the @tagur/gdrive-upload model.
 *
 * All Drive HTTP is stubbed by replacing globalThis.fetch, so folder
 * find-vs-create, the quota-project header, and the upload-many batch
 * (including a partial failure) are tested without touching Google Drive.
 *
 * @module
 */
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260706.24";
import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import { model } from "./gdrive_upload.ts";

type FolderCtx = Parameters<
  typeof model.methods["ensure-folder"]["execute"]
>[1];
type ManyCtx = Parameters<typeof model.methods["upload-many"]["execute"]>[1];

function harnessCtx() {
  const harness = createModelTestContext({
    globalArgs: {
      accessToken: "test-token",
      quotaProject: "proj-123",
      timeoutMs: 30000,
    },
  });
  const written: Array<
    { spec: string; name: string; data: Record<string, unknown> }
  > = [];
  const context = {
    ...harness.context,
    logger: {
      ...harness.context.logger,
      info: harness.context.logger.info ?? (() => {}),
      warning: (harness.context.logger as { warn?: unknown }).warn ??
        (() => {}),
    },
    writeResource: (
      spec: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      written.push({ spec, name, data });
      return Promise.resolve({ name });
    },
  };
  return { context, written };
}

/** Swap globalThis.fetch for `impl`, run `fn`, then restore. */
async function withFetch(
  impl: (url: string, init?: RequestInit) => Response | Promise<Response>,
  fn: () => Promise<unknown>,
): Promise<{ calls: Array<{ url: string; init?: RequestInit }> }> {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return Promise.resolve(impl(url, init));
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
  return { calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

Deno.test("ensure-folder: returns existing folder without creating", async () => {
  const { context, written } = harnessCtx();
  const { calls } = await withFetch(
    (url) => {
      if (url.includes("/files?") && url.includes("q=")) {
        return json({ files: [{ id: "FID1", name: "Inbox" }] });
      }
      throw new Error("unexpected call: " + url);
    },
    () =>
      model.methods["ensure-folder"].execute(
        { name: "Inbox", parentId: "root" },
        context as unknown as FolderCtx,
      ),
  );
  assertEquals(written[0].data.folderId, "FID1");
  assertEquals(written[0].data.created, false);
  // Only the search call, no POST create.
  assertEquals(calls.length, 1);
  // Quota-project header present.
  assert(
    (calls[0].init?.headers as Record<string, string>)[
      "x-goog-user-project"
    ] ===
      "proj-123",
  );
});

Deno.test("ensure-folder: creates when absent", async () => {
  const { context, written } = harnessCtx();
  const { calls } = await withFetch(
    (_url, init) => {
      if (init?.method === "POST") return json({ id: "NEWID", name: "Inbox" });
      return json({ files: [] }); // search finds nothing
    },
    () =>
      model.methods["ensure-folder"].execute(
        { name: "Inbox", parentId: "root" },
        context as unknown as FolderCtx,
      ),
  );
  assertEquals(written[0].data.folderId, "NEWID");
  assertEquals(written[0].data.created, true);
  assertEquals(calls.length, 2); // search + create
});

Deno.test("upload-many: uploads a batch and continues past a failure", async () => {
  const { context, written } = harnessCtx();
  // Stage two real temp files to read.
  const dir = await Deno.makeTempDir();
  const okPath = `${dir}/a.txt`;
  const badPath = `${dir}/b.txt`;
  await Deno.writeTextFile(okPath, "hello");
  await Deno.writeTextFile(badPath, "world");

  let n = 0;
  await withFetch(
    () => {
      n++;
      // First upload ok, second returns a 403 error.
      return n === 1
        ? json({ id: "F1", name: "a.txt", mimeType: "text/plain" })
        : json({ error: { message: "quota exceeded" } }, 403);
    },
    () =>
      model.methods["upload-many"].execute(
        {
          folderId: "FID",
          files: [
            { path: okPath, name: "a.txt", mimeType: "text/plain" },
            { path: badPath, name: "b.txt", mimeType: "text/plain" },
          ],
        },
        context as unknown as ManyCtx,
      ),
  );

  const rec = written[0].data;
  assertEquals(rec.total, 2);
  assertEquals(rec.uploaded, 1);
  assertEquals(rec.failed, 1);
  const results = rec.results as Array<Record<string, unknown>>;
  assertEquals(results[0].ok, true);
  assertEquals(results[0].fileId, "F1");
  assertEquals(results[1].ok, false);
  assert(String(results[1].error).includes("quota"));

  await Deno.remove(dir, { recursive: true });
});
