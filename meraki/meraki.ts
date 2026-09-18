/**
 * Cisco Meraki Dashboard API v1 integration model.
 *
 * Reads organization inventory and status from the Meraki Dashboard API and
 * stores every record as a separately addressable resource (factory pattern),
 * enabling CEL queries, cross-model composition, and drift detection across
 * versioned snapshots.
 *
 * A single model instance can cover many Meraki organizations: `profiles` maps
 * a friendly name to an organization ID plus its own API key, and every method
 * fans out over all profiles in one run (or a single profile via `--arg
 * profile=<name>`). Fanning out inside one method acquires the per-model lock
 * once instead of contending across N separate runs.
 *
 * Authentication follows the documented v1 scheme — `Authorization: Bearer
 * <key>` — and pagination follows RFC5988 `Link` headers. Per-organization rate
 * limits (10 req/s) are respected by honoring `Retry-After` on HTTP 429 with
 * exponential backoff.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** Documented base URL for the Meraki Dashboard API v1. */
const DEFAULT_BASE_URL = "https://api.meraki.com/api/v1";

/** Maximum `timespan` the clients endpoint accepts, in seconds (31 days). */
const MAX_CLIENT_TIMESPAN = 2678400;

const ProfileSchema = z.object({
  apiKey: z.string().min(1).meta({ sensitive: true }).describe(
    "Meraki Dashboard API key for this organization — supply via a vault expression",
  ),
  organizationId: z.string().min(1).optional().describe(
    "Organization ID to operate on. Omit to auto-discover every organization the key can see.",
  ),
  baseUrl: z.string().url().optional().describe(
    "Override the API base URL for this profile (e.g. a regional dashboard such as https://api.meraki.cn/api/v1)",
  ),
});

type Profile = z.infer<typeof ProfileSchema>;

const GlobalArgsSchema = z.object({
  profiles: z.record(z.string(), ProfileSchema).describe(
    "Named organization profiles — each with its own API key and optional organization ID",
  ),
  baseUrl: z.string().url().default(DEFAULT_BASE_URL).describe(
    "Default API base URL for profiles that do not override it",
  ),
  perPage: z.number().int().min(3).max(1000).default(1000).describe(
    "Entries requested per page for paginated endpoints",
  ),
  maxPages: z.number().int().min(1).max(1000).default(50).describe(
    "Page cap per endpoint per organization — guards against unbounded fetches",
  ),
  maxRetries: z.number().int().min(0).max(10).default(4).describe(
    "Retry attempts for rate-limited (429) and transient (5xx) responses",
  ),
  includeLicenseKeys: z.boolean().default(false).describe(
    "Store the licenseKey field on license records — off by default, license keys are credentials",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Fields this model injects into every record so cross-org data stays attributable. */
const originFields = {
  profile: z.string(),
  organizationId: z.string(),
};

const OrganizationSchema = z.object({
  ...originFields,
  id: z.string(),
  name: z.string(),
  url: z.string().optional(),
}).passthrough();

const NetworkSchema = z.object({
  ...originFields,
  id: z.string(),
  name: z.string(),
  productTypes: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  timeZone: z.string().optional(),
  url: z.string().optional(),
}).passthrough();

const DeviceSchema = z.object({
  ...originFields,
  serial: z.string(),
  name: z.string().nullable().optional(),
  mac: z.string().optional(),
  model: z.string().optional(),
  networkId: z.string().nullable().optional(),
  productType: z.string().optional(),
  firmware: z.string().optional(),
  lanIp: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
}).passthrough();

const DeviceStatusSchema = z.object({
  ...originFields,
  serial: z.string(),
  name: z.string().nullable().optional(),
  status: z.string().optional(),
  productType: z.string().optional(),
  model: z.string().optional(),
  networkId: z.string().nullable().optional(),
  lastReportedAt: z.string().nullable().optional(),
  publicIp: z.string().nullable().optional(),
  lanIp: z.string().nullable().optional(),
}).passthrough();

const LicenseSchema = z.object({
  ...originFields,
  id: z.string(),
  licenseType: z.string().optional(),
  licenseKey: z.string().optional(),
  state: z.string().optional(),
  deviceSerial: z.string().nullable().optional(),
  networkId: z.string().nullable().optional(),
  expirationDate: z.string().nullable().optional(),
  claimDate: z.string().nullable().optional(),
  durationInDays: z.number().nullable().optional(),
}).passthrough();

const UplinkStatusSchema = z.object({
  ...originFields,
  serial: z.string(),
  networkId: z.string().optional(),
  model: z.string().optional(),
  lastReportedAt: z.string().nullable().optional(),
  uplinks: z.array(z.unknown()).optional(),
}).passthrough();

const ClientSchema = z.object({
  ...originFields,
  networkId: z.string(),
  id: z.string(),
  mac: z.string().nullable().optional(),
  ip: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  user: z.string().nullable().optional(),
  vlan: z.union([z.string(), z.number()]).nullable().optional(),
  ssid: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  manufacturer: z.string().nullable().optional(),
  os: z.string().nullable().optional(),
  firstSeen: z.union([z.string(), z.number()]).nullable().optional(),
  lastSeen: z.union([z.string(), z.number()]).nullable().optional(),
  recentDeviceSerial: z.string().nullable().optional(),
  recentDeviceName: z.string().nullable().optional(),
}).passthrough();

const SnapshotSchema = z.object({
  method: z.string(),
  profile: z.string(),
  organizationIds: z.array(z.string()),
  count: z.number(),
  requests: z.number(),
  truncated: z.boolean(),
  errors: z.array(z.string()),
  syncedAt: z.string(),
});

const ResponseSchema = z.object({
  profile: z.string(),
  organizationId: z.string(),
  path: z.string(),
  query: z.record(z.string(), z.string()),
  status: z.number(),
  count: z.number(),
  truncated: z.boolean(),
  body: z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]),
  fetchedAt: z.string(),
});

/** Minimal logger surface used by the fetch helpers. */
interface Log {
  debug: (msg: string, props?: Record<string, unknown>) => void;
  info: (msg: string, props?: Record<string, unknown>) => void;
  warning: (msg: string, props?: Record<string, unknown>) => void;
}

/** Resolve the base URL for a profile, trimming any trailing slashes. */
function baseUrlFor(globalArgs: GlobalArgs, profile: Profile): string {
  return (profile.baseUrl ?? globalArgs.baseUrl).replace(/\/+$/, "");
}

/** Query parameter values — arrays become repeated `key[]=` pairs. */
type Query = Record<string, string | string[]>;

/**
 * Build an absolute API URL from a v1-relative path and query parameters.
 *
 * Array-valued parameters are appended once per element, which is how the
 * Dashboard API expects list filters (`networkIds[]=N_1&networkIds[]=N_2`) —
 * comma-joining them into a single pair is not parsed as a list.
 */
function buildUrl(
  baseUrl: string,
  path: string,
  query?: Query,
): string {
  const url = new URL(`${baseUrl}/${path.replace(/^\/+/, "")}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (Array.isArray(value)) {
      for (const entry of value) url.searchParams.append(key, entry);
    } else {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

/** Substitute `{organizationId}` placeholders in a caller-supplied path. */
function renderPath(path: string, organizationId: string): string {
  return path.replaceAll("{organizationId}", organizationId);
}

/** Extract the `rel=next` URL from an RFC5988 `Link` header, if present. */
function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel\s*=\s*"?next"?/i);
    if (match) return match[1];
  }
  return null;
}

/** Sleep for `ms`, rejecting early if the run is cancelled. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Run cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error("Run cancelled"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Seconds to wait from a `Retry-After` header, falling back to exponential backoff. */
function retryDelayMs(header: string | null, attempt: number): number {
  const seconds = header === null ? NaN : Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 60000);
  }
  return Math.min(1000 * 2 ** attempt, 30000);
}

/** Result of a single API request. */
interface ApiResult {
  status: number;
  body: unknown;
  linkHeader: string | null;
  requests: number;
}

/**
 * Issue one GET against the Dashboard API, retrying rate-limited (429) and
 * transient (5xx) responses with `Retry-After`-aware backoff.
 *
 * Throws on any response that is still not OK once retries are exhausted; the
 * message carries the status and a truncated response body so callers can tell
 * a revoked key (401) from an unsupported licensing model (400).
 */
async function apiGet(
  url: string,
  apiKey: string,
  maxRetries: number,
  logger: Log,
  signal?: AbortSignal,
): Promise<ApiResult> {
  let requests = 0;

  for (let attempt = 0;; attempt++) {
    requests++;
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "User-Agent": "swamp-meraki-model",
      },
      signal,
    });

    if (resp.ok) {
      return {
        status: resp.status,
        body: await resp.json(),
        linkHeader: resp.headers.get("Link"),
        requests,
      };
    }

    const transient = resp.status === 429 || resp.status >= 500;
    const body = await resp.text().catch(() => "");

    if (!transient || attempt >= maxRetries) {
      throw new Error(
        `Meraki API ${resp.status} ${resp.statusText} for ${redactUrl(url)}: ${
          body.slice(0, 500)
        }`,
      );
    }

    const waitMs = retryDelayMs(resp.headers.get("Retry-After"), attempt);
    logger.warning(
      "Meraki API {status} on {url} — retrying in {waitMs}ms (attempt {attempt} of {maxRetries})",
      {
        status: resp.status,
        url: redactUrl(url),
        waitMs,
        attempt: attempt + 1,
        maxRetries,
      },
    );
    await delay(waitMs, signal);
  }
}

/** Strip query parameters from a URL so logs and errors stay free of tokens. */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

/** Result of walking every page of a list endpoint. */
interface PagedResult {
  items: Record<string, unknown>[];
  truncated: boolean;
  requests: number;
}

/**
 * Follow `Link: rel=next` until the endpoint is exhausted or `maxPages` is hit.
 *
 * `truncated` reports honestly whether the page cap stopped the walk early.
 */
async function fetchAllPages(
  baseUrl: string,
  path: string,
  query: Query,
  profile: Profile,
  globalArgs: GlobalArgs,
  logger: Log,
  signal?: AbortSignal,
): Promise<PagedResult> {
  const items: Record<string, unknown>[] = [];
  let url: string | null = buildUrl(baseUrl, path, {
    ...query,
    perPage: String(globalArgs.perPage),
  });
  let pages = 0;
  let requests = 0;

  while (url) {
    const result = await apiGet(
      url,
      profile.apiKey,
      globalArgs.maxRetries,
      logger,
      signal,
    );
    requests += result.requests;
    pages++;

    if (!Array.isArray(result.body)) {
      throw new Error(
        `Meraki API returned a non-array body for ${path} — expected a list response`,
      );
    }
    for (const entry of result.body) {
      if (entry !== null && typeof entry === "object") {
        items.push(entry as Record<string, unknown>);
      }
    }

    const next = nextLink(result.linkHeader);
    if (next && pages >= globalArgs.maxPages) {
      logger.warning(
        "Page cap reached for {path} after {pages} pages — results truncated",
        { path, pages },
      );
      return { items, truncated: true, requests };
    }
    url = next;
  }

  return { items, truncated: false, requests };
}

/** Lowercase, filesystem-safe slug for use inside a data instance name. */
function slug(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned === "" ? "unnamed" : cleaned;
}

/**
 * Select the profiles a method should act on.
 *
 * Throws when a named profile is unknown so a typo fails loudly instead of
 * silently syncing nothing.
 */
function selectProfiles(
  globalArgs: GlobalArgs,
  name?: string,
): [string, Profile][] {
  const entries = Object.entries(globalArgs.profiles);
  if (entries.length === 0) {
    throw new Error("No profiles configured — set globalArguments.profiles");
  }
  if (name === undefined) return entries;

  const match = entries.find(([key]) => key === name);
  if (!match) {
    throw new Error(
      `Unknown profile "${name}" — configured profiles: ${
        entries.map(([key]) => key).join(", ")
      }`,
    );
  }
  return [match];
}

/**
 * Resolve which organization IDs a profile targets.
 *
 * An explicit `organizationId` is used as-is; otherwise every organization the
 * key can see is discovered via `GET /organizations`.
 */
async function resolveOrganizationIds(
  profile: Profile,
  globalArgs: GlobalArgs,
  logger: Log,
  signal?: AbortSignal,
): Promise<{ ids: string[]; requests: number }> {
  if (profile.organizationId) {
    return { ids: [profile.organizationId], requests: 0 };
  }

  const result = await apiGet(
    buildUrl(baseUrlFor(globalArgs, profile), "organizations"),
    profile.apiKey,
    globalArgs.maxRetries,
    logger,
    signal,
  );
  if (!Array.isArray(result.body)) {
    throw new Error(
      "GET /organizations did not return a list of organizations",
    );
  }
  const ids = result.body
    .map((org) => (org as { id?: unknown }).id)
    .filter((id): id is string => typeof id === "string");

  return { ids, requests: result.requests };
}

/** Minimal write surface a sync method needs from the method context. */
interface SyncContext {
  globalArgs: GlobalArgs;
  signal?: AbortSignal;
  logger: Log;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

/** Per-profile accumulator used to build the snapshot resource. */
interface ProfileRun {
  organizationIds: string[];
  count: number;
  requests: number;
  truncated: boolean;
  errors: string[];
}

/**
 * Shared driver for every org-scoped list endpoint.
 *
 * Fans out over the selected profiles and, within each profile, over every
 * resolved organization. A failure against one organization is recorded on that
 * profile's snapshot and the run continues; the method only throws when every
 * profile failed, so one co-terminated or permission-limited org cannot mask
 * results from the rest of the fleet.
 */
async function syncOrgEndpoint(
  ctx: SyncContext,
  opts: {
    method: string;
    specName: string;
    path: (organizationId: string) => string;
    query?: Query;
    instanceKey: (record: Record<string, unknown>, index: number) => string;
    transform?: (record: Record<string, unknown>) => Record<string, unknown>;
    profile?: string;
  },
): Promise<{ dataHandles: { name: string }[] }> {
  const profiles = selectProfiles(ctx.globalArgs, opts.profile);
  const handles: { name: string }[] = [];
  const runs = new Map<string, ProfileRun>();
  const seen = new Set<string>();

  ctx.logger.info("Running {method} across {profileCount} profile(s)", {
    method: opts.method,
    profileCount: profiles.length,
  });

  for (const [profileName, profile] of profiles) {
    const run: ProfileRun = {
      organizationIds: [],
      count: 0,
      requests: 0,
      truncated: false,
      errors: [],
    };
    runs.set(profileName, run);

    let orgIds: string[];
    try {
      const resolved = await resolveOrganizationIds(
        profile,
        ctx.globalArgs,
        ctx.logger,
        ctx.signal,
      );
      orgIds = resolved.ids;
      run.requests += resolved.requests;
      run.organizationIds = orgIds;
    } catch (err) {
      run.errors.push(`organization discovery failed: ${message(err)}`);
      continue;
    }

    for (const organizationId of orgIds) {
      try {
        const page = await fetchAllPages(
          baseUrlFor(ctx.globalArgs, profile),
          opts.path(organizationId),
          opts.query ?? {},
          profile,
          ctx.globalArgs,
          ctx.logger,
          ctx.signal,
        );
        run.requests += page.requests;
        run.truncated = run.truncated || page.truncated;

        for (const [index, record] of page.items.entries()) {
          const enriched = {
            ...(opts.transform ? opts.transform(record) : record),
            profile: profileName,
            organizationId,
          };
          const name = uniqueName(
            seen,
            `${opts.specName}-${slug(profileName)}-${
              slug(opts.instanceKey(record, index))
            }`,
          );
          handles.push(await ctx.writeResource(opts.specName, name, enriched));
          run.count++;
        }
      } catch (err) {
        run.errors.push(`org ${organizationId}: ${message(err)}`);
        ctx.logger.warning(
          "{method} failed for org {organizationId}: {error}",
          {
            method: opts.method,
            organizationId,
            error: message(err),
          },
        );
      }
    }
  }

  return finishRun(ctx, opts.method, runs, seen, handles);
}

/**
 * Finalize a fan-out run: write one snapshot per profile, then decide whether
 * the run as a whole failed.
 *
 * Records are written as they are fetched, so throwing here on any error would
 * leave data behind for a method the engine marks failed. The run therefore
 * only throws when it produced nothing at all and hit errors — a genuine total
 * failure, reached before any record write happened. Partial failures (one
 * unreachable org, a co-terminated licensing model) stay visible in that
 * profile's snapshot `errors` and as `warning` logs, so a workflow can assert
 * on them without losing the records that did come back.
 */
async function finishRun(
  ctx: SyncContext,
  method: string,
  runs: Map<string, ProfileRun>,
  seen: Set<string>,
  handles: { name: string }[],
): Promise<{ dataHandles: { name: string }[] }> {
  const total = [...runs.values()].reduce((sum, run) => sum + run.count, 0);
  const errors = [...runs.values()].flatMap((run) => run.errors);

  if (total === 0 && errors.length > 0) {
    throw new Error(`${method} produced no data: ${errors.join("; ")}`);
  }

  for (const [profileName, run] of runs) {
    handles.push(await writeSnapshot(ctx, method, profileName, run, seen));
  }

  ctx.logger.info(
    "{method} stored {count} record(s) from {profileCount} profile(s)",
    { method, count: total, profileCount: runs.size },
  );
  if (errors.length > 0) {
    ctx.logger.warning(
      "{method} completed with {errorCount} error(s) — see snapshot errors",
      { method, errorCount: errors.length },
    );
  }

  return { dataHandles: handles };
}

/** Write one snapshot resource describing a profile's portion of the run. */
function writeSnapshot(
  ctx: SyncContext,
  method: string,
  profileName: string,
  run: ProfileRun,
  seen: Set<string>,
): Promise<{ name: string }> {
  const name = uniqueName(
    seen,
    `snapshot-${slug(method)}-${slug(profileName)}`,
  );
  return ctx.writeResource("snapshot", name, {
    method,
    profile: profileName,
    organizationIds: run.organizationIds,
    count: run.count,
    requests: run.requests,
    truncated: run.truncated,
    errors: run.errors,
    syncedAt: new Date().toISOString(),
  });
}

/**
 * Ensure a data instance name is unique within the run.
 *
 * Instance names map to storage paths across every spec, so a collision would
 * silently clobber an earlier write and fail handle validation.
 */
function uniqueName(seen: Set<string>, candidate: string): string {
  if (!seen.has(candidate)) {
    seen.add(candidate);
    return candidate;
  }
  for (let suffix = 2;; suffix++) {
    const next = `${candidate}-${suffix}`;
    if (!seen.has(next)) {
      seen.add(next);
      return next;
    }
  }
}

/** Normalize an unknown thrown value to a message string. */
function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Read a string field from an API record, falling back to a default. */
function field(
  record: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : fallback;
}

/** Cisco Meraki Dashboard API v1 integration. */
export const model = {
  type: "@tagur/meraki",
  version: "2026.09.17.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "organization": {
      description: "Meraki organization visible to a profile's API key",
      schema: OrganizationSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "network": {
      description: "Network within an organization",
      schema: NetworkSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "device": {
      description: "Device in an organization's inventory",
      schema: DeviceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "deviceStatus": {
      description: "Reachability and addressing status for a device",
      schema: DeviceStatusSchema,
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
    "license": {
      description: "Per-device license entitlement",
      schema: LicenseSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "uplinkStatus": {
      description: "WAN uplink status for an appliance or cellular gateway",
      schema: UplinkStatusSchema,
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
    "client": {
      description: "Client observed on a network within the lookback window",
      schema: ClientSchema,
      lifetime: "30d" as const,
      garbageCollection: 5,
    },
    "snapshot": {
      description:
        "Per-profile run metadata — organizations covered, counts, truncation, and errors",
      schema: SnapshotSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "response": {
      description: "Raw response body from an arbitrary Dashboard API GET",
      schema: ResponseSchema,
      lifetime: "30d" as const,
      garbageCollection: 5,
    },
  },
  checks: {
    "profiles-configured": {
      description:
        "Verify at least one profile is configured and every profile carries an API key",
      labels: ["policy"],
      execute: (context: {
        globalArgs: GlobalArgs;
      }): Promise<{ pass: boolean; errors?: string[] }> => {
        const entries = Object.entries(context.globalArgs.profiles);
        if (entries.length === 0) {
          return Promise.resolve({
            pass: false,
            errors: ["No profiles configured — set globalArguments.profiles"],
          });
        }
        const errors = entries
          .filter(([, profile]) => profile.apiKey.trim() === "")
          .map(([name]) => `Profile "${name}" has an empty apiKey`);
        return Promise.resolve(
          errors.length > 0 ? { pass: false, errors } : { pass: true },
        );
      },
    },
    "api-reachable": {
      description:
        "Verify every profile's API key authenticates against the Dashboard API",
      labels: ["live"],
      execute: async (context: {
        globalArgs: GlobalArgs;
        logger: Log;
      }): Promise<{ pass: boolean; errors?: string[] }> => {
        const errors: string[] = [];
        for (
          const [name, profile] of Object.entries(
            context.globalArgs.profiles,
          )
        ) {
          try {
            await apiGet(
              buildUrl(
                baseUrlFor(context.globalArgs, profile),
                "organizations",
              ),
              profile.apiKey,
              0,
              context.logger,
            );
          } catch (err) {
            errors.push(`Profile "${name}": ${message(err)}`);
          }
        }
        return errors.length > 0 ? { pass: false, errors } : { pass: true };
      },
    },
  },
  methods: {
    sync_organizations: {
      description:
        "List every organization each profile's API key can see. Fans out over all profiles unless one is named.",
      arguments: z.object({
        profile: z.string().optional().describe(
          "Limit the run to a single configured profile",
        ),
      }),
      execute: async (
        args: { profile?: string },
        context: SyncContext,
      ): Promise<{ dataHandles: { name: string }[] }> => {
        const profiles = selectProfiles(context.globalArgs, args.profile);
        const handles: { name: string }[] = [];
        const runs = new Map<string, ProfileRun>();
        const seen = new Set<string>();

        context.logger.info(
          "Listing organizations across {profileCount} profile(s)",
          { profileCount: profiles.length },
        );

        for (const [profileName, profile] of profiles) {
          const run: ProfileRun = {
            organizationIds: [],
            count: 0,
            requests: 0,
            truncated: false,
            errors: [],
          };
          runs.set(profileName, run);

          try {
            const result = await apiGet(
              buildUrl(
                baseUrlFor(context.globalArgs, profile),
                "organizations",
              ),
              profile.apiKey,
              context.globalArgs.maxRetries,
              context.logger,
              context.signal,
            );
            run.requests += result.requests;

            if (!Array.isArray(result.body)) {
              throw new Error(
                "GET /organizations did not return a list of organizations",
              );
            }

            for (const [index, entry] of result.body.entries()) {
              if (entry === null || typeof entry !== "object") continue;
              const record = entry as Record<string, unknown>;
              const id = field(record, "id", String(index));
              if (
                profile.organizationId && id !== profile.organizationId
              ) {
                continue;
              }
              const name = uniqueName(
                seen,
                `organization-${slug(profileName)}-${slug(id)}`,
              );
              handles.push(
                await context.writeResource("organization", name, {
                  ...record,
                  profile: profileName,
                  organizationId: id,
                }),
              );
              run.organizationIds.push(id);
              run.count++;
            }
          } catch (err) {
            run.errors.push(message(err));
            context.logger.warning(
              "Organization listing failed for profile {profile}: {error}",
              { profile: profileName, error: message(err) },
            );
          }
        }

        return finishRun(
          context,
          "sync_organizations",
          runs,
          seen,
          handles,
        );
      },
    },
    sync_networks: {
      description:
        "Sync every network in each profile's organization(s). Optionally filter by configuration-template or tag.",
      arguments: z.object({
        profile: z.string().optional().describe(
          "Limit the run to a single configured profile",
        ),
        tags: z.array(z.string()).optional().describe(
          "Only return networks carrying these tags",
        ),
      }),
      execute: (
        args: { profile?: string; tags?: string[] },
        context: SyncContext,
      ): Promise<{ dataHandles: { name: string }[] }> =>
        syncOrgEndpoint(context, {
          method: "sync_networks",
          specName: "network",
          path: (orgId) => `organizations/${orgId}/networks`,
          query: args.tags?.length
            ? { "tags[]": args.tags, tagsFilterType: "withAnyTags" }
            : {},
          instanceKey: (record, index) => field(record, "id", String(index)),
          profile: args.profile,
        }),
    },
    sync_devices: {
      description:
        "Sync the device inventory for each profile's organization(s), including unclaimed devices.",
      arguments: z.object({
        profile: z.string().optional().describe(
          "Limit the run to a single configured profile",
        ),
        productTypes: z.array(z.string()).optional().describe(
          "Filter by product type (appliance, switch, wireless, camera, sensor, cellularGateway)",
        ),
      }),
      execute: (
        args: { profile?: string; productTypes?: string[] },
        context: SyncContext,
      ): Promise<{ dataHandles: { name: string }[] }> =>
        syncOrgEndpoint(context, {
          method: "sync_devices",
          specName: "device",
          path: (orgId) => `organizations/${orgId}/devices`,
          query: args.productTypes?.length
            ? { "productTypes[]": args.productTypes }
            : {},
          instanceKey: (record, index) =>
            field(record, "serial", String(index)),
          profile: args.profile,
        }),
    },
    sync_device_statuses: {
      description:
        "Sync reachability status (online, offline, alerting, dormant) for every device in each organization.",
      arguments: z.object({
        profile: z.string().optional().describe(
          "Limit the run to a single configured profile",
        ),
        statuses: z.array(z.string()).optional().describe(
          "Filter to specific statuses (online, alerting, offline, dormant)",
        ),
      }),
      execute: (
        args: { profile?: string; statuses?: string[] },
        context: SyncContext,
      ): Promise<{ dataHandles: { name: string }[] }> =>
        syncOrgEndpoint(context, {
          method: "sync_device_statuses",
          specName: "deviceStatus",
          path: (orgId) => `organizations/${orgId}/devices/statuses`,
          query: args.statuses?.length ? { "statuses[]": args.statuses } : {},
          instanceKey: (record, index) =>
            field(record, "serial", String(index)),
          profile: args.profile,
        }),
    },
    sync_licenses: {
      description:
        "Sync per-device license entitlements. Co-termination organizations are recorded as a snapshot error rather than failing the run.",
      arguments: z.object({
        profile: z.string().optional().describe(
          "Limit the run to a single configured profile",
        ),
        state: z.string().optional().describe(
          "Filter by license state (active, expired, expiring, recentlyQueued, unused, unusedActive)",
        ),
      }),
      execute: (
        args: { profile?: string; state?: string },
        context: SyncContext,
      ): Promise<{ dataHandles: { name: string }[] }> =>
        syncOrgEndpoint(context, {
          method: "sync_licenses",
          specName: "license",
          path: (orgId) => `organizations/${orgId}/licenses`,
          query: args.state ? { state: args.state } : {},
          instanceKey: (record, index) => field(record, "id", String(index)),
          transform: (record) => {
            if (context.globalArgs.includeLicenseKeys) return record;
            const { licenseKey: _licenseKey, ...rest } = record;
            return rest;
          },
          profile: args.profile,
        }),
    },
    sync_uplink_statuses: {
      description:
        "Sync WAN uplink status for appliances and cellular gateways across each organization.",
      arguments: z.object({
        profile: z.string().optional().describe(
          "Limit the run to a single configured profile",
        ),
        networkIds: z.array(z.string()).optional().describe(
          "Restrict results to specific network IDs",
        ),
      }),
      execute: (
        args: { profile?: string; networkIds?: string[] },
        context: SyncContext,
      ): Promise<{ dataHandles: { name: string }[] }> =>
        syncOrgEndpoint(context, {
          method: "sync_uplink_statuses",
          specName: "uplinkStatus",
          path: (orgId) => `organizations/${orgId}/uplinks/statuses`,
          query: args.networkIds?.length
            ? { "networkIds[]": args.networkIds }
            : {},
          instanceKey: (record, index) =>
            field(record, "serial", String(index)),
          profile: args.profile,
        }),
    },
    sync_clients: {
      description:
        "Sync clients seen on the given networks within the lookback window. Networks must be named explicitly — run sync_networks first to discover IDs.",
      arguments: z.object({
        profile: z.string().optional().describe(
          "Limit the run to a single configured profile",
        ),
        networkIds: z.array(z.string()).min(1).describe(
          "Network IDs to fetch clients for",
        ),
        timespan: z.number().int().min(60).max(MAX_CLIENT_TIMESPAN).default(
          86400,
        ).describe(
          "Lookback window in seconds — the API caps this at 2678400 (31 days)",
        ),
      }),
      execute: async (
        args: { profile?: string; networkIds: string[]; timespan: number },
        context: SyncContext,
      ): Promise<{ dataHandles: { name: string }[] }> => {
        const profiles = selectProfiles(context.globalArgs, args.profile);
        const handles: { name: string }[] = [];
        const runs = new Map<string, ProfileRun>();
        const seen = new Set<string>();

        context.logger.info(
          "Fetching clients for {networkCount} network(s) across {profileCount} profile(s)",
          {
            networkCount: args.networkIds.length,
            profileCount: profiles.length,
          },
        );

        for (const [profileName, profile] of profiles) {
          const run: ProfileRun = {
            organizationIds: profile.organizationId
              ? [profile.organizationId]
              : [],
            count: 0,
            requests: 0,
            truncated: false,
            errors: [],
          };
          runs.set(profileName, run);

          for (const networkId of args.networkIds) {
            try {
              const page = await fetchAllPages(
                baseUrlFor(context.globalArgs, profile),
                `networks/${networkId}/clients`,
                { timespan: String(args.timespan) },
                profile,
                context.globalArgs,
                context.logger,
                context.signal,
              );
              run.requests += page.requests;
              run.truncated = run.truncated || page.truncated;

              for (const [index, record] of page.items.entries()) {
                const clientId = field(record, "id", String(index));
                const name = uniqueName(
                  seen,
                  `client-${slug(profileName)}-${slug(networkId)}-${
                    slug(clientId)
                  }`,
                );
                handles.push(
                  await context.writeResource("client", name, {
                    ...record,
                    networkId,
                    profile: profileName,
                    organizationId: profile.organizationId ?? "",
                  }),
                );
                run.count++;
              }
            } catch (err) {
              run.errors.push(`network ${networkId}: ${message(err)}`);
              context.logger.warning(
                "Client fetch failed for network {networkId}: {error}",
                { networkId, error: message(err) },
              );
            }
          }
        }

        return finishRun(context, "sync_clients", runs, seen, handles);
      },
    },
    request: {
      description:
        "Read-only escape hatch: GET any Dashboard API v1 path and store the raw response. Use {organizationId} in the path to substitute the profile's organization.",
      arguments: z.object({
        path: z.string().min(1).describe(
          "API path relative to /api/v1 (e.g. organizations/{organizationId}/admins)",
        ),
        query: z.record(z.string(), z.string()).optional().describe(
          "Query parameters to append",
        ),
        profile: z.string().optional().describe(
          "Limit the run to a single configured profile",
        ),
        paginate: z.boolean().default(false).describe(
          "Follow Link headers and store the combined array instead of a single page",
        ),
      }),
      execute: async (
        args: {
          path: string;
          query?: Record<string, string>;
          profile?: string;
          paginate: boolean;
        },
        context: SyncContext,
      ): Promise<{ dataHandles: { name: string }[] }> => {
        const profiles = selectProfiles(context.globalArgs, args.profile);
        const seen = new Set<string>();
        const query = args.query ?? {};

        // Every response is fetched before anything is written so a failure
        // partway through the fan-out leaves no half-written result set behind.
        const pending: { name: string; data: Record<string, unknown> }[] = [];

        context.logger.info(
          "GET {path} across {profileCount} profile(s)",
          { path: args.path, profileCount: profiles.length },
        );

        for (const [profileName, profile] of profiles) {
          const orgIds = profile.organizationId
            ? [profile.organizationId]
            : args.path.includes("{organizationId}")
            ? (await resolveOrganizationIds(
              profile,
              context.globalArgs,
              context.logger,
              context.signal,
            )).ids
            : [""];

          for (const organizationId of orgIds) {
            const path = renderPath(args.path, organizationId);
            let body: unknown;
            let status: number;
            let truncated = false;

            if (args.paginate) {
              const page = await fetchAllPages(
                baseUrlFor(context.globalArgs, profile),
                path,
                query,
                profile,
                context.globalArgs,
                context.logger,
                context.signal,
              );
              body = page.items;
              status = 200;
              truncated = page.truncated;
            } else {
              const result = await apiGet(
                buildUrl(baseUrlFor(context.globalArgs, profile), path, query),
                profile.apiKey,
                context.globalArgs.maxRetries,
                context.logger,
                context.signal,
              );
              body = result.body;
              status = result.status;
              truncated = nextLink(result.linkHeader) !== null;
            }

            const normalized = Array.isArray(body)
              ? body
              : body !== null && typeof body === "object"
              ? body as Record<string, unknown>
              : { value: body };

            const name = uniqueName(
              seen,
              `response-${slug(profileName)}-${slug(path)}`,
            );
            pending.push({
              name,
              data: {
                profile: profileName,
                organizationId,
                path,
                query,
                status,
                count: Array.isArray(normalized)
                  ? normalized.length
                  : Object.keys(normalized).length,
                truncated,
                body: normalized,
                fetchedAt: new Date().toISOString(),
              },
            });
          }
        }

        const handles: { name: string }[] = [];
        for (const entry of pending) {
          handles.push(
            await context.writeResource("response", entry.name, entry.data),
          );
        }

        context.logger.info("Stored {count} response(s)", {
          count: handles.length,
        });

        return { dataHandles: handles };
      },
    },
  },
};
