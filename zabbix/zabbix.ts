/**
 * Zabbix API model for swamp.
 *
 * Read-only access to the Zabbix JSON-RPC API. Fetches trend (hourly
 * min/avg/max) or raw history time-series for items across a host group,
 * matching hosts by name regex — e.g. concurrent-user counts on Ivanti/Pulse
 * Secure VPN appliances. Mirrors the query the Grafana Zabbix datasource runs,
 * but as versioned, scriptable swamp data.
 *
 * All methods are read-only against Zabbix (hostgroup.get, host.get, item.get,
 * trend.get, history.get, apiinfo.version). Nothing is ever written back to
 * Zabbix; results are persisted only in swamp's local datastore.
 *
 * @module
 */
import { z } from "npm:zod@4";

// =============================================================================
// Global arguments
// =============================================================================

const GlobalArgsSchema = z.object({
  endpoint: z.string().describe(
    "Zabbix JSON-RPC endpoint, e.g. https://zabbix.example.com/zabbix/api_jsonrpc.php",
  ),
  token: z.string().meta({ sensitive: true }).describe(
    "Zabbix API token (only used by data methods; apiinfo.version needs none)",
  ),
  authStyle: z.enum(["bearer", "body"]).default("bearer").describe(
    "Token transport: 'bearer' = Authorization header (Zabbix 6.4+), 'body' = auth field (5.4-6.2)",
  ),
  caCert: z.string().optional().describe(
    "Optional PEM CA certificate for internal/self-signed TLS endpoints",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// =============================================================================
// Method context
// =============================================================================

type MethodContext = {
  globalArgs: GlobalArgs;
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  logger?: { info: (msg: string, props?: Record<string, unknown>) => void };
};

// =============================================================================
// Zabbix JSON-RPC helper (read-only usage)
// =============================================================================

type ZabbixError = { code: number; message: string; data?: string };

/**
 * Make a single Zabbix JSON-RPC 2.0 call. Pass `token: undefined` for
 * unauthenticated methods such as apiinfo.version.
 */
async function zabbixCall<T>(
  ctx: GlobalArgs,
  method: string,
  params: unknown,
  opts: { token?: string; client?: Deno.HttpClient } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json-rpc",
  };
  const payload: Record<string, unknown> = {
    jsonrpc: "2.0",
    method,
    params: params ?? {},
    id: 1,
  };
  if (opts.token) {
    if ((ctx.authStyle ?? "bearer") === "body") {
      payload.auth = opts.token;
    } else {
      headers["Authorization"] = `Bearer ${opts.token}`;
    }
  }

  const init: RequestInit & { client?: Deno.HttpClient } = {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  };
  if (opts.client) init.client = opts.client;

  const resp = await fetch(ctx.endpoint, init);
  if (!resp.ok) {
    throw new Error(
      `Zabbix HTTP ${resp.status} ${resp.statusText} calling ${method}`,
    );
  }
  const data = await resp.json() as { result?: T; error?: ZabbixError };
  if (data.error) {
    throw new Error(
      `Zabbix API error on ${method}: ${data.error.message}${
        data.error.data ? ` — ${data.error.data}` : ""
      }`,
    );
  }
  return data.result as T;
}

/** Build a Deno HTTP client that trusts a custom CA, or undefined for default. */
function makeClient(ctx: GlobalArgs): Deno.HttpClient | undefined {
  if (!ctx.caCert) return undefined;
  return Deno.createHttpClient({ caCerts: [ctx.caCert] });
}

/** Sanitize a host name into a safe swamp data-instance name. */
function instanceName(host: string): string {
  return host.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") ||
    "host";
}

/** Slugify an item name for use in data-instance names. */
function itemSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(
    /^-+|-+$/g,
    "",
  ) || "item";
}

// Raw Zabbix response shapes (all IDs/values are strings in the API).
interface RawHostGroup {
  groupid: string;
  name: string;
}
interface RawHost {
  hostid: string;
  name: string;
}
interface RawItem {
  itemid: string;
  name: string;
  hostid: string;
  value_type: string;
  units: string;
  lastvalue?: string;
}
interface RawTrend {
  itemid: string;
  clock: string;
  num: string;
  value_min: string;
  value_avg: string;
  value_max: string;
}
interface RawHistory {
  itemid: string;
  clock: string;
  value: string;
  ns?: string;
}

interface Point {
  clock: number;
  timestamp: string;
  min: number;
  avg: number;
  max: number;
  count: number;
}

/** Resolve host group -> hosts (regex-filtered) -> matching items. */
async function resolveItems(
  ctx: GlobalArgs,
  client: Deno.HttpClient | undefined,
  hostGroup: string,
  hostFilter: string,
  itemName: string,
  match: "exact" | "contains",
): Promise<{ hosts: Map<string, string>; items: RawItem[] }> {
  const token = ctx.token;

  const groups = await zabbixCall<RawHostGroup[]>(ctx, "hostgroup.get", {
    output: ["groupid", "name"],
    filter: { name: [hostGroup] },
  }, { token, client });
  if (groups.length === 0) {
    throw new Error(`No host group named "${hostGroup}" found in Zabbix`);
  }
  const groupids = groups.map((g) => g.groupid);

  const allHosts = await zabbixCall<RawHost[]>(ctx, "host.get", {
    output: ["hostid", "name"],
    groupids,
  }, { token, client });

  const re = new RegExp(hostFilter);
  const hosts = new Map<string, string>(); // hostid -> name
  for (const h of allHosts) {
    if (re.test(h.name)) hosts.set(h.hostid, h.name);
  }
  if (hosts.size === 0) {
    throw new Error(
      `No hosts in group "${hostGroup}" matched /${hostFilter}/ (${allHosts.length} hosts in group)`,
    );
  }

  const itemParams: Record<string, unknown> = {
    output: ["itemid", "name", "hostid", "value_type", "units", "lastvalue"],
    hostids: [...hosts.keys()],
  };
  if (match === "exact") {
    itemParams.filter = { name: [itemName] };
  } else {
    itemParams.search = { name: itemName };
  }
  const items = await zabbixCall<RawItem[]>(
    ctx,
    "item.get",
    itemParams,
    { token, client },
  );
  if (items.length === 0) {
    throw new Error(
      `No items ${
        match === "exact" ? "named" : "matching"
      } "${itemName}" on the ${hosts.size} matched host(s)`,
    );
  }

  return { hosts, items };
}

// =============================================================================
// Model definition
// =============================================================================

/** Zabbix read-only API model definition for swamp. */
export const model = {
  type: "@tagur/zabbix",
  version: "2026.07.10.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    server: {
      description: "Zabbix server version (from apiinfo.version)",
      schema: z.object({
        version: z.string(),
        endpoint: z.string(),
        fetchedAt: z.string(),
      }),
      lifetime: "infinite" as const,
      garbageCollection: 3,
    },
    discovery: {
      description: "Hosts and items matching the group/host/item filters",
      schema: z.object({
        hostGroup: z.string(),
        hostFilter: z.string(),
        itemName: z.string(),
        hosts: z.array(z.object({
          hostId: z.string(),
          host: z.string(),
          items: z.array(z.object({
            itemId: z.string(),
            name: z.string(),
            units: z.string(),
            valueType: z.string(),
            lastValue: z.string(),
          })),
        })),
        fetchedAt: z.string(),
      }),
      lifetime: "1h" as const,
      garbageCollection: 5,
    },
    series: {
      description: "Per-host time-series of an item (one instance per host)",
      schema: z.object({
        host: z.string(),
        itemId: z.string(),
        itemName: z.string(),
        units: z.string(),
        source: z.string(),
        from: z.string(),
        to: z.string(),
        peak: z.number(),
        average: z.number(),
        latest: z.number(),
        points: z.array(z.object({
          clock: z.number(),
          timestamp: z.string(),
          min: z.number(),
          avg: z.number(),
          max: z.number(),
          count: z.number(),
        })),
        fetchedAt: z.string(),
      }),
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
    summary: {
      description: "Cross-host summary (peak/avg/latest per host) for one run",
      schema: z.object({
        itemName: z.string(),
        hostGroup: z.string(),
        source: z.string(),
        from: z.string(),
        to: z.string(),
        hostCount: z.number(),
        hosts: z.array(z.object({
          host: z.string(),
          peak: z.number(),
          average: z.number(),
          latest: z.number(),
          points: z.number(),
        })),
        fetchedAt: z.string(),
      }),
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    // ── server_info: confirm the Zabbix version (no auth needed) ───────────
    server_info: {
      description: "Fetch the Zabbix server version (apiinfo.version)",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const ctx = context.globalArgs;
        const client = makeClient(ctx);
        try {
          const version = await zabbixCall<string>(
            ctx,
            "apiinfo.version",
            {},
            { client },
          );
          const handle = await context.writeResource("server", "version", {
            version,
            endpoint: ctx.endpoint,
            fetchedAt: new Date().toISOString(),
          });
          context.logger?.info("Zabbix version {version}", { version });
          return { dataHandles: [handle] };
        } finally {
          client?.close();
        }
      },
    },

    // ── discover: list matching hosts and items (verify names) ─────────────
    discover: {
      description:
        "List hosts (name regex) in a host group and their matching items",
      arguments: z.object({
        hostGroup: z.string().default("Servers - Remote Access"),
        hostFilter: z.string().default(".*ra0.*").describe(
          "Regex matched against host name",
        ),
        itemName: z.string().default("Concurrent Users").describe(
          "Item name to match",
        ),
        match: z.enum(["exact", "contains"]).default("contains").describe(
          "'exact' = item name equals itemName, 'contains' = substring match (good for discovery)",
        ),
      }),
      execute: async (
        args: {
          hostGroup: string;
          hostFilter: string;
          itemName: string;
          match: "exact" | "contains";
        },
        context: MethodContext,
      ) => {
        const ctx = context.globalArgs;
        const client = makeClient(ctx);
        try {
          const { hosts, items } = await resolveItems(
            ctx,
            client,
            args.hostGroup,
            args.hostFilter,
            args.itemName,
            args.match,
          );
          const byHost = new Map<string, RawItem[]>();
          for (const it of items) {
            (byHost.get(it.hostid) ?? byHost.set(it.hostid, []).get(it.hostid)!)
              .push(it);
          }
          const hostList = [...hosts.entries()].map(([hostId, host]) => ({
            hostId,
            host,
            items: (byHost.get(hostId) ?? []).map((it) => ({
              itemId: it.itemid,
              name: it.name,
              units: it.units,
              valueType: it.value_type,
              lastValue: it.lastvalue ?? "",
            })),
          }));
          const handle = await context.writeResource("discovery", "discovery", {
            hostGroup: args.hostGroup,
            hostFilter: args.hostFilter,
            itemName: args.itemName,
            hosts: hostList,
            fetchedAt: new Date().toISOString(),
          });
          context.logger?.info("Discovered {hosts} host(s), {items} item(s)", {
            hosts: hosts.size,
            items: items.length,
          });
          return { dataHandles: [handle] };
        } finally {
          client?.close();
        }
      },
    },

    // ── trends: the concurrent-users time-series, one resource per host ────
    trends: {
      description:
        "Fetch trend (hourly min/avg/max) or raw history for an item across matched hosts",
      arguments: z.object({
        hostGroup: z.string().default("Servers - Remote Access"),
        hostFilter: z.string().default(".*ra0.*").describe(
          "Regex matched against host name",
        ),
        itemName: z.string().default("Concurrent Users").describe(
          "Item name to match",
        ),
        match: z.enum(["exact", "contains"]).default("exact").describe(
          "'exact' = item name equals itemName (default, one series per host), 'contains' = substring match",
        ),
        days: z.number().int().positive().default(30).describe(
          "Days of history to fetch, ending now",
        ),
        source: z.enum(["trends", "history"]).default("trends").describe(
          "'trends' = hourly aggregates (long retention), 'history' = raw values",
        ),
      }),
      execute: async (
        args: {
          hostGroup: string;
          hostFilter: string;
          itemName: string;
          match: "exact" | "contains";
          days: number;
          source: "trends" | "history";
        },
        context: MethodContext,
      ) => {
        const ctx = context.globalArgs;
        const token = ctx.token;
        const client = makeClient(ctx);
        try {
          const { hosts, items } = await resolveItems(
            ctx,
            client,
            args.hostGroup,
            args.hostFilter,
            args.itemName,
            args.match,
          );

          const itemMeta = new Map<string, RawItem>();
          for (const it of items) itemMeta.set(it.itemid, it);
          const itemids = [...itemMeta.keys()];

          const timeTill = Math.floor(Date.now() / 1000);
          const timeFrom = timeTill - args.days * 86400;
          const fromIso = new Date(timeFrom * 1000).toISOString();
          const toIso = new Date(timeTill * 1000).toISOString();

          // Collect points keyed by itemid.
          const pointsByItem = new Map<string, Point[]>();
          for (const id of itemids) pointsByItem.set(id, []);

          if (args.source === "trends") {
            const trends = await zabbixCall<RawTrend[]>(ctx, "trend.get", {
              output: "extend",
              itemids,
              time_from: timeFrom,
              time_till: timeTill,
            }, { token, client });
            for (const t of trends) {
              pointsByItem.get(t.itemid)?.push({
                clock: Number(t.clock),
                timestamp: new Date(Number(t.clock) * 1000).toISOString(),
                min: Number(t.value_min),
                avg: Number(t.value_avg),
                max: Number(t.value_max),
                count: Number(t.num),
              });
            }
          } else {
            // history.get requires the value_type per call; group items by type.
            const byType = new Map<number, string[]>();
            for (const it of items) {
              const vt = Number(it.value_type);
              (byType.get(vt) ?? byType.set(vt, []).get(vt)!).push(it.itemid);
            }
            for (const [vt, ids] of byType) {
              const hist = await zabbixCall<RawHistory[]>(ctx, "history.get", {
                output: "extend",
                history: vt,
                itemids: ids,
                time_from: timeFrom,
                time_till: timeTill,
              }, { token, client });
              for (const h of hist) {
                const v = Number(h.value);
                pointsByItem.get(h.itemid)?.push({
                  clock: Number(h.clock),
                  timestamp: new Date(Number(h.clock) * 1000).toISOString(),
                  min: v,
                  avg: v,
                  max: v,
                  count: 1,
                });
              }
            }
          }

          const handles: Array<{ name: string }> = [];
          const summaryHosts: Array<{
            host: string;
            peak: number;
            average: number;
            latest: number;
            points: number;
          }> = [];
          const fetchedAt = new Date().toISOString();
          const usedNames = new Set<string>();

          for (const id of itemids) {
            const meta = itemMeta.get(id)!;
            const host = hosts.get(meta.hostid) ?? meta.hostid;
            // Unique data-instance name: host + item slug so different items
            // (e.g. Concurrent Users vs Concurrent Max License) for the same
            // host don't clobber each other. Disambiguate by itemId on the
            // rare chance two matched items share a name on one host.
            const base = `${instanceName(host)}-${itemSlug(meta.name)}`;
            let dataName = base;
            if (usedNames.has(dataName)) dataName = `${base}-${id}`;
            usedNames.add(dataName);
            const pts = (pointsByItem.get(id) ?? []).sort((a, b) =>
              a.clock - b.clock
            );
            const peak = pts.length ? Math.max(...pts.map((p) => p.max)) : 0;
            const average = pts.length
              ? pts.reduce((s, p) => s + p.avg, 0) / pts.length
              : 0;
            const latest = pts.length ? pts[pts.length - 1].avg : 0;

            const handle = await context.writeResource(
              "series",
              dataName,
              {
                host,
                itemId: id,
                itemName: meta.name,
                units: meta.units,
                source: args.source,
                from: fromIso,
                to: toIso,
                peak,
                average,
                latest,
                points: pts,
                fetchedAt,
              },
            );
            handles.push(handle);
            summaryHosts.push({
              host,
              peak,
              average,
              latest,
              points: pts.length,
            });
          }

          summaryHosts.sort((a, b) => b.peak - a.peak);
          const summaryHandle = await context.writeResource(
            "summary",
            `summary-${itemSlug(args.itemName)}`,
            {
              itemName: args.itemName,
              hostGroup: args.hostGroup,
              source: args.source,
              from: fromIso,
              to: toIso,
              hostCount: summaryHosts.length,
              hosts: summaryHosts,
              fetchedAt,
            },
          );
          handles.push(summaryHandle);

          context.logger?.info(
            "Fetched {source} for {hosts} host(s) over {days}d",
            { source: args.source, hosts: hosts.size, days: args.days },
          );
          return { dataHandles: handles };
        } finally {
          client?.close();
        }
      },
    },
  },
};
