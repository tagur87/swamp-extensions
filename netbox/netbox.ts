/**
 * Generic NetBox REST API integration model.
 *
 * Works with any NetBox instance and any API endpoint. Fetches objects via
 * the REST API and stores each as a separately addressable resource using
 * the factory pattern — enabling CEL queries, cross-model composition,
 * and drift detection via versioned snapshots.
 *
 * @module
 */
import { z } from "npm:zod@4";

const MAX_ERROR_BODY = 512;
const CHECK_TIMEOUT_MS = 15_000;

const GlobalArgsSchema = z.object({
  url: z.string().url().describe(
    "NetBox base URL (e.g. https://nsot.example.com)",
  ),
  token: z.string().meta({ sensitive: true }).describe("NetBox API token"),
  endpoint: z.string().describe(
    "REST API path relative to /api/ (e.g. dcim/sites, ipam/prefixes)",
  ),
  filters: z.record(z.string(), z.string()).optional()
    .describe(
      "Query parameter filters (e.g. {region: 'amer', status: 'active'})",
    ),
  pageSize: z.number().min(1).max(1000).default(200)
    .describe("Results per page for paginated requests"),
  caCert: z.string().optional().describe(
    "Optional PEM CA certificate for internal/self-signed TLS endpoints",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const ItemSchema = z.object({
  id: z.number(),
  url: z.string().optional(),
  display: z.string().optional(),
}).passthrough();

const SnapshotSchema = z.object({
  endpoint: z.string(),
  filters: z.record(z.string(), z.string()),
  count: z.number(),
  itemIds: z.array(z.number()),
  syncedAt: z.string(),
});

function makeClient(ctx: GlobalArgs): Deno.HttpClient | undefined {
  if (!ctx.caCert) return undefined;
  return Deno.createHttpClient({ caCerts: [ctx.caCert] });
}

function truncateBody(body: string): string {
  if (body.length <= MAX_ERROR_BODY) return body;
  return body.slice(0, MAX_ERROR_BODY) + "… (truncated)";
}

/** Build the full API URL for an endpoint with optional query params. */
function buildUrl(
  baseUrl: string,
  endpoint: string,
  params?: Record<string, string>,
  limit?: number,
  offset?: number,
): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  const ep = endpoint.replace(/^\/+/, "").replace(/\/+$/, "");
  const url = new URL(`${normalized}/api/${ep}/`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }
  if (limit !== undefined) url.searchParams.set("limit", String(limit));
  if (offset !== undefined) url.searchParams.set("offset", String(offset));
  return url.toString();
}

/** Fetch a single page from the NetBox REST API. */
async function fetchPage(
  url: string,
  token: string,
  signal?: AbortSignal,
  client?: Deno.HttpClient,
): Promise<
  { count: number; next: string | null; results: Record<string, unknown>[] }
> {
  const init: RequestInit & { client?: Deno.HttpClient } = {
    headers: {
      Authorization: `Token ${token}`,
      Accept: "application/json",
    },
    signal,
  };
  if (client) init.client = client;

  const resp = await fetch(url, init);

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(
      `NetBox API ${resp.status} ${resp.statusText}: ${truncateBody(body)}`,
    );
  }

  return await resp.json();
}

/** Derive a stable, filesystem-safe instance name from a NetBox object. */
function instanceName(endpoint: string, obj: Record<string, unknown>): string {
  const slug = typeof obj.slug === "string" ? obj.slug : null;
  const name = typeof obj.name === "string"
    ? obj.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
    : null;
  const id = obj.id;
  const prefix = endpoint.replace(/\//g, "-").replace(/^-|-$/g, "");

  if (slug) return `${prefix}-${slug}-${id}`;
  if (name) return `${prefix}-${name}-${id}`;
  return `${prefix}-${id}`;
}

/** Fetch all objects from a paginated NetBox endpoint. */
async function fetchAll(
  globalArgs: GlobalArgs,
  signal?: AbortSignal,
  client?: Deno.HttpClient,
): Promise<{ objects: Record<string, unknown>[]; totalCount: number }> {
  const objects: Record<string, unknown>[] = [];
  let totalCount = 0;

  let url: string | null = buildUrl(
    globalArgs.url,
    globalArgs.endpoint,
    globalArgs.filters,
    globalArgs.pageSize,
    0,
  );

  while (url) {
    const page = await fetchPage(url, globalArgs.token, signal, client);
    totalCount = page.count;
    objects.push(...page.results);
    url = page.next ?? null;
  }

  return { objects, totalCount };
}

/** Derive a snapshot name from filters so different filter sets don't clobber each other. */
function snapshotName(filters: Record<string, string>): string {
  const keys = Object.keys(filters).sort();
  if (keys.length === 0) return "snapshot";
  const slug = keys.map((k) => `${k}-${filters[k]}`).join("-")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `snapshot-${slug}`;
}

/** NetBox REST API integration. */
export const model = {
  type: "@tagur/netbox",
  version: "2026.07.17.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "item": {
      description: "Individual NetBox object fetched from the API",
      schema: ItemSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "snapshot": {
      description: "Sync metadata — endpoint, filter, count, and timing",
      schema: SnapshotSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  checks: {
    "api-reachable": {
      description: "Verify NetBox API is reachable and token is valid",
      labels: ["live"],
      execute: async (context: {
        globalArgs: GlobalArgs;
      }): Promise<{ pass: boolean; errors?: string[] }> => {
        const client = makeClient(context.globalArgs);
        try {
          const url = buildUrl(
            context.globalArgs.url,
            context.globalArgs.endpoint,
            undefined,
            1,
          );
          const init: RequestInit & { client?: Deno.HttpClient } = {
            headers: {
              Authorization: `Token ${context.globalArgs.token}`,
              Accept: "application/json",
            },
            signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
          };
          if (client) init.client = client;

          const resp = await fetch(url, init);
          if (!resp.ok) {
            return {
              pass: false,
              errors: [`NetBox API returned ${resp.status} ${resp.statusText}`],
            };
          }
          return { pass: true };
        } catch (err) {
          return {
            pass: false,
            errors: [
              `Cannot reach NetBox API: ${
                err instanceof Error ? err.message : String(err)
              }`,
            ],
          };
        } finally {
          client?.close();
        }
      },
    },
  },
  methods: {
    sync: {
      description:
        "Fetch all objects from the configured endpoint and store each as a resource. Supports pagination and filters. Writes a snapshot resource with sync metadata.",
      arguments: z.object({
        filters: z.record(z.string(), z.string()).optional()
          .describe("Override or merge with global filters for this run"),
      }),
      execute: async (
        args: { filters?: Record<string, string> },
        context: {
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
        },
      ) => {
        const mergedFilters = {
          ...context.globalArgs.filters,
          ...args.filters,
        };
        const effectiveArgs = { ...context.globalArgs, filters: mergedFilters };
        const client = makeClient(context.globalArgs);

        try {
          context.logger.info("Fetching from {endpoint}", {
            endpoint: effectiveArgs.endpoint,
          });

          const { objects, totalCount } = await fetchAll(
            effectiveArgs,
            context.signal,
            client,
          );

          context.logger.info("Fetched {fetched} of {total} objects", {
            fetched: objects.length,
            total: totalCount,
          });

          const handles = [];
          const itemIds: number[] = [];

          for (const obj of objects) {
            const name = instanceName(effectiveArgs.endpoint, obj);
            const handle = await context.writeResource("item", name, obj);
            handles.push(handle);
            if (typeof obj.id === "number") itemIds.push(obj.id);
          }

          const snapshotHandle = await context.writeResource(
            "snapshot",
            snapshotName(mergedFilters),
            {
              endpoint: effectiveArgs.endpoint,
              filters: mergedFilters,
              count: objects.length,
              itemIds,
              syncedAt: new Date().toISOString(),
            },
          );
          handles.push(snapshotHandle);

          return { dataHandles: handles };
        } finally {
          client?.close();
        }
      },
    },
    get: {
      description: "Fetch a single object by ID from the configured endpoint.",
      arguments: z.object({
        id: z.number().describe("NetBox object ID to fetch"),
      }),
      execute: async (
        args: { id: number },
        context: {
          globalArgs: GlobalArgs;
          signal: AbortSignal;
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const client = makeClient(context.globalArgs);
        try {
          const url = buildUrl(
            context.globalArgs.url,
            `${context.globalArgs.endpoint}/${args.id}`,
          );

          context.logger.info("Fetching {endpoint}/{id}", {
            endpoint: context.globalArgs.endpoint,
            id: args.id,
          });

          const init: RequestInit & { client?: Deno.HttpClient } = {
            headers: {
              Authorization: `Token ${context.globalArgs.token}`,
              Accept: "application/json",
            },
            signal: context.signal,
          };
          if (client) init.client = client;

          const resp = await fetch(url, init);

          if (!resp.ok) {
            const body = await resp.text().catch(() => "");
            throw new Error(
              `NetBox API ${resp.status} ${resp.statusText}: ${
                truncateBody(body)
              }`,
            );
          }

          const obj = await resp.json();
          const name = instanceName(context.globalArgs.endpoint, obj);
          const handle = await context.writeResource("item", name, obj);
          return { dataHandles: [handle] };
        } finally {
          client?.close();
        }
      },
    },
  },
};
