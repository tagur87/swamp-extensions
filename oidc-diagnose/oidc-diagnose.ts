/**
 * IdP-agnostic OpenID Connect diagnostic model for swamp.
 *
 * Troubleshooting for broken OIDC login flows. Works against any
 * standards-compliant provider (Okta, Auth0, Entra ID, Keycloak, Zitadel,
 * Cognito, Google, …) because it exercises only the OpenID Connect Discovery,
 * token, and JWT standards.
 *
 * Five methods:
 *   - discover:      fetch /.well-known/openid-configuration and validate it
 *                    (issuer match, required endpoints, PKCE, scopes, grants).
 *   - jwks:          fetch the JWKS and report key ids, algorithms, and usage.
 *   - decode-token:  decode a JWT (header + claims, no signature verification),
 *                    sanity-check iss / aud / exp / nbf / iat and the kid
 *                    against a previously discovered JWKS, and (optionally)
 *                    assert that required claims (groups, email, roles, …) are
 *                    present. Entra groups-overage is informational by default.
 *   - exchange-code: exchange an OAuth2 authorization code at the token
 *                    endpoint (confidential client; secret from a vault), then
 *                    decode and claim-check the returned id_token. Reproduces
 *                    the server-side exchange that a proxy (oauth2-proxy,
 *                    Skipper, Pomerium) performs, so you can see the real user
 *                    claims the browser never receives.
 *   - resolve-groups: expand an Entra groups-overage reference into the real
 *                    group list — mints a Microsoft Graph token via a
 *                    client-credentials grant (secret from a vault) and calls
 *                    the _claim_sources endpoint from a prior token.
 *
 * The read-only methods (discover, jwks, decode-token) need no credentials.
 * exchange-code and resolve-groups need a client secret, supplied via a vault.
 *
 * Every method writes a diagnostic resource even when the probe fails, so a
 * broken endpoint still leaves a truthful, queryable record rather than only a
 * thrown error — the whole point of a troubleshooting tool.
 *
 * @module
 */
import { z } from "npm:zod@4.6.5";

const MAX_ERROR_BODY = 512;
const DEFAULT_TIMEOUT_MS = 15_000;
/** Tolerance applied to exp/nbf/iat comparisons to absorb clock skew. */
const DEFAULT_CLOCK_SKEW_S = 120;

const GlobalArgsSchema = z.object({
  issuer: z.string().url().describe(
    "OIDC issuer / provider base URL (e.g. https://login.example.com or " +
      "https://example.okta.com/oauth2/default). The discovery document is " +
      "fetched from <issuer>/.well-known/openid-configuration.",
  ),
  timeoutMs: z.number().int().min(1000).max(120_000).default(DEFAULT_TIMEOUT_MS)
    .describe("Per-request HTTP timeout in milliseconds"),
  caCert: z.string().optional().describe(
    "Optional PEM CA certificate for internal / self-signed TLS endpoints",
  ),
  clockSkewSeconds: z.number().int().min(0).max(3600)
    .default(DEFAULT_CLOCK_SKEW_S)
    .describe("Allowed clock skew (seconds) when checking exp / nbf / iat"),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** A single diagnostic observation. `severity` orders triage. */
const FindingSchema = z.object({
  severity: z.enum(["error", "warning", "info"]),
  code: z.string(),
  message: z.string(),
});

type Finding = z.infer<typeof FindingSchema>;

const DiscoverySchema = z.object({
  issuer: z.string(),
  reachable: z.boolean(),
  statusCode: z.number().optional(),
  discoveryUrl: z.string(),
  resolvedIssuer: z.string().optional(),
  authorizationEndpoint: z.string().optional(),
  tokenEndpoint: z.string().optional(),
  jwksUri: z.string().optional(),
  userinfoEndpoint: z.string().optional(),
  endSessionEndpoint: z.string().optional(),
  scopesSupported: z.array(z.string()).optional(),
  responseTypesSupported: z.array(z.string()).optional(),
  grantTypesSupported: z.array(z.string()).optional(),
  codeChallengeMethodsSupported: z.array(z.string()).optional(),
  findings: z.array(FindingSchema),
  checkedAt: z.string(),
}).passthrough();

const JwksSchema = z.object({
  issuer: z.string(),
  reachable: z.boolean(),
  statusCode: z.number().optional(),
  jwksUri: z.string().optional(),
  keyCount: z.number(),
  keys: z.array(
    z.object({
      kid: z.string().optional(),
      kty: z.string().optional(),
      alg: z.string().optional(),
      use: z.string().optional(),
    }).passthrough(),
  ),
  findings: z.array(FindingSchema),
  checkedAt: z.string(),
});

const TokenSchema = z.object({
  issuer: z.string(),
  valid: z.boolean(),
  header: z.record(z.string(), z.unknown()),
  claims: z.record(z.string(), z.unknown()),
  kid: z.string().optional(),
  algorithm: z.string().optional(),
  expiresAt: z.string().optional(),
  notBefore: z.string().optional(),
  issuedAt: z.string().optional(),
  findings: z.array(FindingSchema),
  claimFindings: z.array(FindingSchema),
  source: z.enum(["decode", "exchange"]).optional(),
  checkedAt: z.string(),
});

const GroupsSchema = z.object({
  issuer: z.string(),
  resolved: z.boolean(),
  endpoint: z.string().optional(),
  count: z.number(),
  groups: z.array(z.string()),
  findings: z.array(FindingSchema),
  resolvedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(args: GlobalArgs): Deno.HttpClient | undefined {
  if (!args.caCert) return undefined;
  return Deno.createHttpClient({ caCerts: [args.caCert] });
}

function truncateBody(body: string): string {
  if (body.length <= MAX_ERROR_BODY) return body;
  return body.slice(0, MAX_ERROR_BODY) + "… (truncated)";
}

/** Build the discovery document URL from an issuer, per OIDC Discovery 1.0. */
export function discoveryUrl(issuer: string): string {
  const trimmed = issuer.replace(/\/+$/, "");
  return `${trimmed}/.well-known/openid-configuration`;
}

/** Decode a base64url segment to a UTF-8 string. */
export function base64UrlDecode(segment: string): string {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/")
    .padEnd(Math.ceil(segment.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Fetch JSON with a timeout, returning status alongside the parsed body. */
async function fetchJson(
  url: string,
  args: GlobalArgs,
  signal: AbortSignal,
  client?: Deno.HttpClient,
): Promise<{ ok: boolean; status: number; body: unknown; raw: string }> {
  const timeout = AbortSignal.timeout(args.timeoutMs);
  const combined = AbortSignal.any([signal, timeout]);
  const init: RequestInit & { client?: Deno.HttpClient } = {
    headers: { Accept: "application/json" },
    signal: combined,
  };
  if (client) init.client = client;

  const resp = await fetch(url, init);
  const raw = await resp.text().catch(() => "");
  let body: unknown = undefined;
  try {
    body = raw ? JSON.parse(raw) : undefined;
  } catch {
    body = undefined;
  }
  return { ok: resp.ok, status: resp.status, body, raw };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError") return "request timed out";
    return err.message;
  }
  return String(err);
}

/** Validate a discovery document, accumulating findings. */
export function validateDiscovery(
  requestedIssuer: string,
  doc: Record<string, unknown>,
): Finding[] {
  const findings: Finding[] = [];
  const requested = requestedIssuer.replace(/\/+$/, "");

  const resolvedIssuer = typeof doc.issuer === "string"
    ? doc.issuer
    : undefined;
  if (!resolvedIssuer) {
    findings.push({
      severity: "error",
      code: "issuer-missing",
      message: "Discovery document has no 'issuer' field.",
    });
  } else if (resolvedIssuer.replace(/\/+$/, "") !== requested) {
    // Per OIDC Discovery the issuer in the document MUST match the one used to
    // build the request URL. A mismatch breaks token 'iss' validation.
    findings.push({
      severity: "error",
      code: "issuer-mismatch",
      message:
        `Discovery issuer '${resolvedIssuer}' does not match the requested ` +
        `issuer '${requestedIssuer}'. Tokens from this provider will fail ` +
        `'iss' validation.`,
    });
  }

  const required: Array<[string, string]> = [
    ["authorization_endpoint", "authorization"],
    ["token_endpoint", "token"],
    ["jwks_uri", "JWKS"],
  ];
  for (const [field, label] of required) {
    if (typeof doc[field] !== "string") {
      findings.push({
        severity: "error",
        code: "endpoint-missing",
        message: `Required ${label} endpoint ('${field}') is absent.`,
      });
    }
  }

  if (typeof doc.userinfo_endpoint !== "string") {
    findings.push({
      severity: "warning",
      code: "userinfo-missing",
      message:
        "No 'userinfo_endpoint'. OIDC clients that read profile claims from " +
        "userinfo will have nothing to call.",
    });
  }

  const pkce = doc.code_challenge_methods_supported;
  if (!Array.isArray(pkce) || pkce.length === 0) {
    findings.push({
      severity: "warning",
      code: "pkce-unadvertised",
      message:
        "Provider does not advertise 'code_challenge_methods_supported'. " +
        "Public clients relying on PKCE may fail.",
    });
  } else if (!pkce.includes("S256")) {
    findings.push({
      severity: "warning",
      code: "pkce-no-s256",
      message:
        "PKCE is advertised but 'S256' is not among the supported methods; " +
        "only 'plain' is weak and often rejected by clients.",
    });
  }

  const scopes = doc.scopes_supported;
  if (Array.isArray(scopes) && !scopes.includes("openid")) {
    findings.push({
      severity: "warning",
      code: "openid-scope-missing",
      message:
        "The 'openid' scope is not advertised in 'scopes_supported'. This is " +
        "required for OIDC; the provider may be OAuth2-only.",
    });
  }

  return findings;
}

/** Validate decoded JWT header + claims against the clock and expectations. */
export function validateToken(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  opts: {
    issuer: string;
    skewSeconds: number;
    nowSeconds: number;
    expectedAudience?: string;
    jwksKids?: string[];
  },
): Finding[] {
  const findings: Finding[] = [];
  const now = opts.nowSeconds;
  const skew = opts.skewSeconds;

  const alg = typeof header.alg === "string" ? header.alg : undefined;
  if (!alg) {
    findings.push({
      severity: "error",
      code: "alg-missing",
      message: "JWT header has no 'alg'.",
    });
  } else if (alg === "none") {
    findings.push({
      severity: "error",
      code: "alg-none",
      message:
        "JWT header 'alg' is 'none' — the token is unsigned and must be " +
        "rejected by any conforming verifier.",
    });
  }

  const kid = typeof header.kid === "string" ? header.kid : undefined;
  if (opts.jwksKids && opts.jwksKids.length > 0) {
    if (!kid) {
      findings.push({
        severity: "warning",
        code: "kid-missing",
        message:
          "JWT header has no 'kid'; verifier cannot select a signing key " +
          "deterministically when the JWKS exposes multiple keys.",
      });
    } else if (!opts.jwksKids.includes(kid)) {
      findings.push({
        severity: "error",
        code: "kid-unknown",
        message: `JWT 'kid' '${kid}' is not present in the provider JWKS ` +
          `(${opts.jwksKids.join(", ")}). Signature verification will fail — ` +
          `commonly a key-rotation / stale-cache problem.`,
      });
    }
  }

  const iss = typeof claims.iss === "string" ? claims.iss : undefined;
  if (!iss) {
    findings.push({
      severity: "warning",
      code: "iss-missing",
      message: "Token has no 'iss' claim.",
    });
  } else if (iss.replace(/\/+$/, "") !== opts.issuer.replace(/\/+$/, "")) {
    findings.push({
      severity: "error",
      code: "iss-mismatch",
      message: `Token 'iss' '${iss}' does not match the configured issuer ` +
        `'${opts.issuer}'. Relying parties will reject it.`,
    });
  }

  if (opts.expectedAudience) {
    const aud = claims.aud;
    const audList = Array.isArray(aud)
      ? aud.filter((a): a is string => typeof a === "string")
      : typeof aud === "string"
      ? [aud]
      : [];
    if (audList.length === 0) {
      findings.push({
        severity: "error",
        code: "aud-missing",
        message: "Token has no 'aud' claim but an expected audience was given.",
      });
    } else if (!audList.includes(opts.expectedAudience)) {
      findings.push({
        severity: "error",
        code: "aud-mismatch",
        message:
          `Token 'aud' (${audList.join(", ")}) does not include the expected ` +
          `audience '${opts.expectedAudience}'.`,
      });
    }
  }

  const exp = typeof claims.exp === "number" ? claims.exp : undefined;
  if (exp === undefined) {
    findings.push({
      severity: "warning",
      code: "exp-missing",
      message: "Token has no 'exp' claim; it never expires.",
    });
  } else if (now - skew > exp) {
    findings.push({
      severity: "error",
      code: "token-expired",
      message: `Token expired at ${new Date(exp * 1000).toISOString()} ` +
        `(${now - exp}s ago, beyond ${skew}s skew).`,
    });
  }

  const nbf = typeof claims.nbf === "number" ? claims.nbf : undefined;
  if (nbf !== undefined && now + skew < nbf) {
    findings.push({
      severity: "error",
      code: "token-not-yet-valid",
      message:
        `Token 'nbf' is ${new Date(nbf * 1000).toISOString()}, in the future ` +
        `(beyond ${skew}s skew). Check for clock drift.`,
    });
  }

  const iat = typeof claims.iat === "number" ? claims.iat : undefined;
  if (iat !== undefined && now + skew < iat) {
    findings.push({
      severity: "warning",
      code: "iat-future",
      message:
        `Token 'iat' is ${new Date(iat * 1000).toISOString()}, in the future ` +
        `(beyond ${skew}s skew). Likely clock drift between issuer and host.`,
    });
  }

  return findings;
}

/**
 * Assert that required claims are present (and, where given, match expected
 * values). Detects the Entra "groups overage" case: when a user is in too many
 * groups, Entra omits the inline `groups` claim and instead sets
 * `_claim_names` / `_claim_sources` pointing at Microsoft Graph.
 *
 * Overage is NOT inherently a problem — a consumer that resolves groups via
 * Graph (many proxies and apps do) works fine with it. So by default an overage
 * marker *satisfies* a `groups` requirement and is reported only as an `info`
 * finding. Set `requireInlineGroups` when the consumer cannot call Graph and
 * genuinely needs groups inline in the token; overage then becomes an error.
 */
export function validateClaims(
  claims: Record<string, unknown>,
  opts: {
    requiredClaims?: string[];
    expectedGroups?: string[];
    requireInlineGroups?: boolean;
  },
): Finding[] {
  const findings: Finding[] = [];
  const required = opts.requiredClaims ?? [];

  // Entra groups-overage markers.
  const claimNames = claims._claim_names as
    | Record<string, unknown>
    | undefined;
  const hasGroupsOverage = typeof claimNames === "object" &&
    claimNames !== null && "groups" in claimNames;

  // Report overage once, regardless of whether 'groups' is required, so the
  // record always explains an absent inline 'groups' claim.
  if (hasGroupsOverage) {
    findings.push(
      opts.requireInlineGroups
        ? {
          severity: "error",
          code: "groups-overage",
          message:
            "The 'groups' claim is absent (Entra 'groups overage') but inline " +
            "groups were required. The user exceeds the token group limit; " +
            "'_claim_names'/'_claim_sources' point at Microsoft Graph. " +
            "Configure the app to emit only assigned/security groups to stay " +
            "under the limit, or drop requireInlineGroups and resolve groups " +
            "via Graph (see the resolve-groups method).",
        }
        : {
          severity: "info",
          code: "groups-overage",
          message:
            "The 'groups' claim is delivered by reference, not inline (Entra " +
            "'groups overage'): '_claim_names'/'_claim_sources' point at " +
            "Microsoft Graph. Expected when the user is in many groups and the " +
            "consumer resolves groups via Graph. Use resolve-groups to expand " +
            "them.",
        },
    );
  }

  for (const name of required) {
    const value = claims[name];
    const present = value !== undefined && value !== null &&
      !(Array.isArray(value) && value.length === 0) &&
      !(typeof value === "string" && value.length === 0);

    if (!present) {
      // Overage satisfies a 'groups' requirement unless inline groups are
      // explicitly required: the groups exist, just by reference. The overage
      // finding (info or error) was already recorded above.
      if (name === "groups" && hasGroupsOverage) {
        continue;
      }
      findings.push({
        severity: "error",
        code: "claim-missing",
        message: `Required claim '${name}' is absent from the token.` +
          (name === "groups"
            ? " For Entra, enable it in App registration → Token " +
              "configuration (it is not emitted by default)."
            : ""),
      });
      continue;
    }

    if (
      name === "groups" && opts.expectedGroups && opts.expectedGroups.length
    ) {
      const actual = Array.isArray(value)
        ? value.filter((g): g is string => typeof g === "string")
        : typeof value === "string"
        ? [value]
        : [];
      const missing = opts.expectedGroups.filter((g) => !actual.includes(g));
      if (missing.length > 0) {
        findings.push({
          severity: "error",
          code: "groups-mismatch",
          message: `Token 'groups' is missing expected value(s): ` +
            `${missing.join(", ")}. Present: ${
              actual.length ? actual.join(", ") : "(none)"
            }.`,
        });
      }
    }
  }

  return findings;
}

function toIso(seconds: unknown): string | undefined {
  return typeof seconds === "number"
    ? new Date(seconds * 1000).toISOString()
    : undefined;
}

/**
 * Normalize an Entra groups-overage endpoint. Entra still advertises the
 * retired Azure AD Graph host (`graph.windows.net`) in `_claim_sources`, but
 * `getMemberObjects` there is now blocked (403 Authorization_RequestDenied).
 * Rewrite such URLs to the Microsoft Graph equivalent
 * (`https://graph.microsoft.com/v1.0/users/{oid}/getMemberObjects`), extracting
 * the user object id from the legacy path. Modern graph.microsoft.com URLs pass
 * through unchanged. Returns the URL to call and whether it was rewritten.
 */
export function normalizeOverageEndpoint(
  endpoint: string,
): { url: string; rewritten: boolean } {
  if (!endpoint.includes("graph.windows.net")) {
    return { url: endpoint, rewritten: false };
  }
  // Legacy form: https://graph.windows.net/{tenant}/users/{oid}/getMemberObjects
  const match = endpoint.match(/\/users\/([^/]+)\/getMemberObjects/i);
  if (!match) {
    return { url: endpoint, rewritten: false };
  }
  const oid = match[1];
  return {
    url: `https://graph.microsoft.com/v1.0/users/${oid}/getMemberObjects`,
    rewritten: true,
  };
}

// ---------------------------------------------------------------------------
// Behavior definition
// ---------------------------------------------------------------------------

type MethodContext = {
  globalArgs: GlobalArgs;
  signal: AbortSignal;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
  };
  readResource: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

/** IdP-agnostic OpenID Connect diagnostics. */
export const model = {
  type: "@tagur/oidc-diagnose",
  version: "2026.10.16.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.10.16.1",
      description:
        "Add exchange-code and resolve-groups methods and claim assertion " +
        "(requiredClaims / expectedGroups / requireInlineGroups). Entra " +
        "groups-overage is informational by default and satisfies a 'groups' " +
        "requirement unless requireInlineGroups is set; resolve-groups expands " +
        "the _claim_sources Graph endpoint into a 'groups' resource. Adds " +
        "claimFindings and source fields to the token resource and a new " +
        "groups resource; no change to existing global arguments.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    "discovery": {
      description:
        "Validated OIDC discovery document: resolved endpoints and findings",
      schema: DiscoverySchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "jwks": {
      description: "Fetched JWKS summary: key ids, algorithms, and findings",
      schema: JwksSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "token": {
      description:
        "Decoded JWT: header, claims, and standard-claim validation findings",
      schema: TokenSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "groups": {
      description: "Group membership resolved from an Entra groups-overage " +
        "_claim_sources endpoint via a Microsoft Graph token",
      schema: GroupsSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    "discover": {
      description:
        "Fetch <issuer>/.well-known/openid-configuration and validate it: " +
        "issuer match, required endpoints, PKCE methods, scopes, grant types. " +
        "Writes a 'discovery' resource (including on failure) whose endpoints " +
        "the jwks and decode-token methods reference via CEL.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { issuer } = context.globalArgs;
        const url = discoveryUrl(issuer);
        const client = makeClient(context.globalArgs);
        const checkedAt = new Date().toISOString();

        try {
          context.logger.info("Fetching discovery document {url}", { url });
          const res = await fetchJson(
            url,
            context.globalArgs,
            context.signal,
            client,
          );

          if (!res.ok || typeof res.body !== "object" || res.body === null) {
            const data: Record<string, unknown> = {
              issuer,
              reachable: res.ok,
              statusCode: res.status,
              discoveryUrl: url,
              findings: [{
                severity: "error",
                code: res.ok ? "discovery-not-json" : "discovery-unreachable",
                message: res.ok
                  ? `Discovery document is not valid JSON: ${
                    truncateBody(res.raw)
                  }`
                  : `Discovery request returned ${res.status}: ${
                    truncateBody(res.raw)
                  }`,
              }],
              checkedAt,
            };
            const handle = await context.writeResource(
              "discovery",
              "discovery",
              data,
            );
            return { dataHandles: [handle] };
          }

          const doc = res.body as Record<string, unknown>;
          const findings = validateDiscovery(issuer, doc);

          const data: Record<string, unknown> = {
            issuer,
            reachable: true,
            statusCode: res.status,
            discoveryUrl: url,
            resolvedIssuer: typeof doc.issuer === "string"
              ? doc.issuer
              : undefined,
            authorizationEndpoint: doc.authorization_endpoint,
            tokenEndpoint: doc.token_endpoint,
            jwksUri: doc.jwks_uri,
            userinfoEndpoint: doc.userinfo_endpoint,
            endSessionEndpoint: doc.end_session_endpoint,
            scopesSupported: doc.scopes_supported,
            responseTypesSupported: doc.response_types_supported,
            grantTypesSupported: doc.grant_types_supported,
            codeChallengeMethodsSupported: doc.code_challenge_methods_supported,
            findings,
            checkedAt,
          };

          const errors = findings.filter((f) => f.severity === "error").length;
          context.logger.info(
            "Discovery validated: {errors} error finding(s), {total} total",
            { errors, total: findings.length },
          );

          const handle = await context.writeResource(
            "discovery",
            "discovery",
            data,
          );
          return { dataHandles: [handle] };
        } catch (err) {
          const data: Record<string, unknown> = {
            issuer,
            reachable: false,
            discoveryUrl: url,
            findings: [{
              severity: "error",
              code: "discovery-error",
              message: `Could not fetch discovery document: ${
                errorMessage(err)
              }`,
            }],
            checkedAt,
          };
          const handle = await context.writeResource(
            "discovery",
            "discovery",
            data,
          );
          return { dataHandles: [handle] };
        } finally {
          client?.close();
        }
      },
    },
    "jwks": {
      description:
        "Fetch the provider JWKS and report each key's kid, kty, alg, and use. " +
        "Resolves the JWKS URI from a prior 'discover' run (stored discovery " +
        "resource) or the 'jwksUri' argument. Writes a 'jwks' resource.",
      arguments: z.object({
        jwksUri: z.string().url().optional().describe(
          "Explicit JWKS URI. Overrides the URI resolved from discovery.",
        ),
      }),
      execute: async (
        args: { jwksUri?: string },
        context: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { issuer } = context.globalArgs;
        const client = makeClient(context.globalArgs);
        const checkedAt = new Date().toISOString();

        let jwksUri = args.jwksUri;
        if (!jwksUri) {
          const prior = await context.readResource("discovery");
          if (prior && typeof prior.jwksUri === "string") {
            jwksUri = prior.jwksUri;
          }
        }

        if (!jwksUri) {
          const data: Record<string, unknown> = {
            issuer,
            reachable: false,
            keyCount: 0,
            keys: [],
            findings: [{
              severity: "error",
              code: "jwks-uri-unknown",
              message:
                "No JWKS URI available. Run 'discover' first or pass the " +
                "'jwksUri' argument.",
            }],
            checkedAt,
          };
          const handle = await context.writeResource("jwks", "jwks", data);
          return { dataHandles: [handle] };
        }

        try {
          context.logger.info("Fetching JWKS {url}", { url: jwksUri });
          const res = await fetchJson(
            jwksUri,
            context.globalArgs,
            context.signal,
            client,
          );
          const body = res.body as { keys?: unknown } | undefined;
          const keysRaw = Array.isArray(body?.keys) ? body!.keys : [];

          const findings: Finding[] = [];
          if (!res.ok) {
            findings.push({
              severity: "error",
              code: "jwks-unreachable",
              message: `JWKS request returned ${res.status}: ${
                truncateBody(res.raw)
              }`,
            });
          } else if (keysRaw.length === 0) {
            findings.push({
              severity: "error",
              code: "jwks-empty",
              message:
                "JWKS has no keys. Token signatures cannot be verified against " +
                "this provider.",
            });
          }

          const keys = keysRaw.map((k) => {
            const key = k as Record<string, unknown>;
            return {
              kid: typeof key.kid === "string" ? key.kid : undefined,
              kty: typeof key.kty === "string" ? key.kty : undefined,
              alg: typeof key.alg === "string" ? key.alg : undefined,
              use: typeof key.use === "string" ? key.use : undefined,
            };
          });

          if (keys.length > 1 && keys.some((k) => !k.kid)) {
            findings.push({
              severity: "warning",
              code: "kid-absent-multikey",
              message:
                "JWKS exposes multiple keys but at least one lacks a 'kid'; " +
                "verifiers cannot select a key deterministically.",
            });
          }

          const data: Record<string, unknown> = {
            issuer,
            reachable: res.ok,
            statusCode: res.status,
            jwksUri,
            keyCount: keys.length,
            keys,
            findings,
            checkedAt,
          };
          context.logger.info("JWKS fetched: {count} key(s)", {
            count: keys.length,
          });
          const handle = await context.writeResource("jwks", "jwks", data);
          return { dataHandles: [handle] };
        } catch (err) {
          const data: Record<string, unknown> = {
            issuer,
            reachable: false,
            jwksUri,
            keyCount: 0,
            keys: [],
            findings: [{
              severity: "error",
              code: "jwks-error",
              message: `Could not fetch JWKS: ${errorMessage(err)}`,
            }],
            checkedAt,
          };
          const handle = await context.writeResource("jwks", "jwks", data);
          return { dataHandles: [handle] };
        } finally {
          client?.close();
        }
      },
    },
    "decode-token": {
      description:
        "Decode a JWT (header + claims; signature is NOT cryptographically " +
        "verified) and sanity-check alg, kid, iss, aud, exp, nbf, iat against " +
        "the clock, the configured issuer, and the kids from a prior 'jwks' " +
        "run. Optionally assert required claims are present (groups, email, " +
        "roles, …), with Entra groups-overage detection. Writes a 'token' " +
        "resource with per-claim findings.",
      arguments: z.object({
        token: z.string().meta({ sensitive: true }).describe(
          "The JWT to decode (an access_token or id_token). Treated as " +
            "sensitive — stored claims are kept but the raw token is not.",
        ),
        expectedAudience: z.string().optional().describe(
          "Expected 'aud' value (the client_id or resource identifier). When " +
            "set, a mismatch is flagged as an error.",
        ),
        requiredClaims: z.array(z.string()).optional().describe(
          "Claim names that must be present and non-empty (e.g. " +
            "['groups','email','roles','preferred_username']). Each absent " +
            "claim is an error finding; absent 'groups' under Entra overage is " +
            "a distinct 'groups-overage' warning.",
        ),
        expectedGroups: z.array(z.string()).optional().describe(
          "Specific group values (ids or names) the 'groups' claim must " +
            "include. Missing values are flagged as 'groups-mismatch'.",
        ),
        requireInlineGroups: z.boolean().optional().describe(
          "When true, require the 'groups' claim inline in the token: Entra " +
            "groups-overage becomes an error instead of informational. Leave " +
            "false (default) when the consumer resolves groups via Graph.",
        ),
      }),
      execute: async (
        args: {
          token: string;
          expectedAudience?: string;
          requiredClaims?: string[];
          expectedGroups?: string[];
          requireInlineGroups?: boolean;
        },
        context: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { issuer, clockSkewSeconds } = context.globalArgs;
        const checkedAt = new Date().toISOString();
        const nowSeconds = Math.floor(Date.now() / 1000);

        const parts = args.token.split(".");
        if (parts.length < 2) {
          const data: Record<string, unknown> = {
            issuer,
            valid: false,
            header: {},
            claims: {},
            findings: [{
              severity: "error",
              code: "token-malformed",
              message:
                "Token is not a JWT: expected at least header.payload segments.",
            }],
            claimFindings: [],
            source: "decode",
            checkedAt,
          };
          const handle = await context.writeResource("token", "token", data);
          return { dataHandles: [handle] };
        }

        let header: Record<string, unknown>;
        let claims: Record<string, unknown>;
        try {
          header = JSON.parse(base64UrlDecode(parts[0]));
          claims = JSON.parse(base64UrlDecode(parts[1]));
        } catch (err) {
          const data: Record<string, unknown> = {
            issuer,
            valid: false,
            header: {},
            claims: {},
            findings: [{
              severity: "error",
              code: "token-undecodable",
              message: `Could not base64url-decode JWT segments: ${
                errorMessage(err)
              }`,
            }],
            claimFindings: [],
            source: "decode",
            checkedAt,
          };
          const handle = await context.writeResource("token", "token", data);
          return { dataHandles: [handle] };
        }

        // Pull known key ids from a prior jwks run, if present, to catch
        // kid mismatches without re-fetching.
        let jwksKids: string[] | undefined;
        const priorJwks = await context.readResource("jwks");
        if (priorJwks && Array.isArray(priorJwks.keys)) {
          jwksKids = (priorJwks.keys as Array<Record<string, unknown>>)
            .map((k) => (typeof k.kid === "string" ? k.kid : undefined))
            .filter((k): k is string => k !== undefined);
        }

        const findings = validateToken(header, claims, {
          issuer,
          skewSeconds: clockSkewSeconds,
          nowSeconds,
          expectedAudience: args.expectedAudience,
          jwksKids,
        });

        const claimFindings = validateClaims(claims, {
          requiredClaims: args.requiredClaims,
          expectedGroups: args.expectedGroups,
          requireInlineGroups: args.requireInlineGroups,
        });

        const valid = ![...findings, ...claimFindings].some(
          (f) => f.severity === "error",
        );
        const data: Record<string, unknown> = {
          issuer,
          valid,
          header,
          claims,
          kid: typeof header.kid === "string" ? header.kid : undefined,
          algorithm: typeof header.alg === "string" ? header.alg : undefined,
          expiresAt: toIso(claims.exp),
          notBefore: toIso(claims.nbf),
          issuedAt: toIso(claims.iat),
          findings,
          claimFindings,
          source: "decode",
          checkedAt,
        };

        context.logger.info(
          "Token decoded: valid={valid}, {errors} error finding(s), " +
            "{claimErrors} claim error(s)",
          {
            valid,
            errors: findings.filter((f) => f.severity === "error").length,
            claimErrors:
              claimFindings.filter((f) => f.severity === "error").length,
          },
        );
        const handle = await context.writeResource("token", "token", data);
        return { dataHandles: [handle] };
      },
    },
    "exchange-code": {
      description:
        "Exchange an OAuth2 authorization code at the token endpoint " +
        "(confidential client; secret from a vault), then decode and " +
        "claim-check the returned id_token. Reproduces the server-side " +
        "exchange a proxy performs so you can inspect the real user claims " +
        "(groups, email, roles, …) the browser never receives. Resolves the " +
        "token endpoint and jwks kids from prior 'discover' / 'jwks' runs. " +
        "Writes a 'token' resource; the raw code and secret are never stored.",
      arguments: z.object({
        code: z.string().meta({ sensitive: true }).describe(
          "The authorization code from the redirect callback (?code=...). " +
            "Single-use and short-lived; sensitive, never stored.",
        ),
        clientId: z.string().describe(
          "The OAuth2 client_id (application id). Also used as the expected " +
            "id_token audience.",
        ),
        clientSecret: z.string().meta({ sensitive: true }).describe(
          "The client secret. Supply via a vault reference " +
            "(${{ vault.get(<vault>, <key>) }}), not a literal.",
        ),
        redirectUri: z.string().url().describe(
          "The redirect_uri registered for the app; must match the one used " +
            "to obtain the code, or the exchange fails with " +
            "'redirect_uri_mismatch'.",
        ),
        codeVerifier: z.string().optional().meta({ sensitive: true }).describe(
          "PKCE code_verifier, if the authorization request used PKCE.",
        ),
        requiredClaims: z.array(z.string()).optional().describe(
          "Claim names the id_token must contain (e.g. ['groups','email']).",
        ),
        expectedGroups: z.array(z.string()).optional().describe(
          "Group values the 'groups' claim must include.",
        ),
        requireInlineGroups: z.boolean().optional().describe(
          "When true, Entra groups-overage is an error instead of info.",
        ),
      }),
      execute: async (
        args: {
          code: string;
          clientId: string;
          clientSecret: string;
          redirectUri: string;
          codeVerifier?: string;
          requiredClaims?: string[];
          expectedGroups?: string[];
          requireInlineGroups?: boolean;
        },
        context: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { issuer, clockSkewSeconds } = context.globalArgs;
        const checkedAt = new Date().toISOString();
        const client = makeClient(context.globalArgs);

        // Resolve the token endpoint from a prior discover run.
        let tokenEndpoint: string | undefined;
        const priorDiscovery = await context.readResource("discovery");
        if (
          priorDiscovery && typeof priorDiscovery.tokenEndpoint === "string"
        ) {
          tokenEndpoint = priorDiscovery.tokenEndpoint;
        }
        if (!tokenEndpoint) {
          const data: Record<string, unknown> = {
            issuer,
            valid: false,
            header: {},
            claims: {},
            findings: [{
              severity: "error",
              code: "token-endpoint-unknown",
              message:
                "No token endpoint available. Run 'discover' first so the " +
                "token_endpoint can be resolved.",
            }],
            claimFindings: [],
            source: "exchange",
            checkedAt,
          };
          const handle = await context.writeResource("token", "token", data);
          return { dataHandles: [handle] };
        }

        try {
          const form = new URLSearchParams({
            grant_type: "authorization_code",
            code: args.code,
            redirect_uri: args.redirectUri,
            client_id: args.clientId,
            client_secret: args.clientSecret,
          });
          if (args.codeVerifier) form.set("code_verifier", args.codeVerifier);

          context.logger.info("Exchanging code at {endpoint}", {
            endpoint: tokenEndpoint,
          });

          const timeout = AbortSignal.timeout(context.globalArgs.timeoutMs);
          const combined = AbortSignal.any([context.signal, timeout]);
          const init: RequestInit & { client?: Deno.HttpClient } = {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              Accept: "application/json",
            },
            body: form.toString(),
            signal: combined,
          };
          if (client) init.client = client;

          const resp = await fetch(tokenEndpoint, init);
          const rawBody = await resp.text().catch(() => "");
          let body: Record<string, unknown> = {};
          try {
            body = rawBody ? JSON.parse(rawBody) : {};
          } catch {
            body = {};
          }

          if (!resp.ok) {
            // OAuth2 error responses carry 'error' / 'error_description'.
            const oauthErr = typeof body.error === "string"
              ? body.error
              : `http_${resp.status}`;
            const desc = typeof body.error_description === "string"
              ? body.error_description
              : truncateBody(rawBody);
            const data: Record<string, unknown> = {
              issuer,
              valid: false,
              header: {},
              claims: {},
              findings: [{
                severity: "error",
                code: `exchange-${oauthErr}`,
                message: `Token exchange failed (${oauthErr}): ${desc}`,
              }],
              claimFindings: [],
              source: "exchange",
              checkedAt,
            };
            const handle = await context.writeResource("token", "token", data);
            return { dataHandles: [handle] };
          }

          const idToken = typeof body.id_token === "string"
            ? body.id_token
            : undefined;
          if (!idToken) {
            const data: Record<string, unknown> = {
              issuer,
              valid: false,
              header: {},
              claims: {},
              findings: [{
                severity: "error",
                code: "id-token-absent",
                message:
                  "Exchange succeeded but the response has no 'id_token'. " +
                  "Ensure the 'openid' scope was requested in the authorize " +
                  "step.",
              }],
              claimFindings: [],
              source: "exchange",
              checkedAt,
            };
            const handle = await context.writeResource("token", "token", data);
            return { dataHandles: [handle] };
          }

          const parts = idToken.split(".");
          let header: Record<string, unknown>;
          let claims: Record<string, unknown>;
          try {
            header = JSON.parse(base64UrlDecode(parts[0]));
            claims = JSON.parse(base64UrlDecode(parts[1]));
          } catch (err) {
            const data: Record<string, unknown> = {
              issuer,
              valid: false,
              header: {},
              claims: {},
              findings: [{
                severity: "error",
                code: "token-undecodable",
                message: `Could not decode the returned id_token: ${
                  errorMessage(err)
                }`,
              }],
              claimFindings: [],
              source: "exchange",
              checkedAt,
            };
            const handle = await context.writeResource("token", "token", data);
            return { dataHandles: [handle] };
          }

          let jwksKids: string[] | undefined;
          const priorJwks = await context.readResource("jwks");
          if (priorJwks && Array.isArray(priorJwks.keys)) {
            jwksKids = (priorJwks.keys as Array<Record<string, unknown>>)
              .map((k) => (typeof k.kid === "string" ? k.kid : undefined))
              .filter((k): k is string => k !== undefined);
          }

          const nowSeconds = Math.floor(Date.now() / 1000);
          const findings = validateToken(header, claims, {
            issuer,
            skewSeconds: clockSkewSeconds,
            nowSeconds,
            expectedAudience: args.clientId,
            jwksKids,
          });
          const claimFindings = validateClaims(claims, {
            requiredClaims: args.requiredClaims,
            expectedGroups: args.expectedGroups,
            requireInlineGroups: args.requireInlineGroups,
          });

          const valid = ![...findings, ...claimFindings].some(
            (f) => f.severity === "error",
          );
          const data: Record<string, unknown> = {
            issuer,
            valid,
            header,
            claims,
            kid: typeof header.kid === "string" ? header.kid : undefined,
            algorithm: typeof header.alg === "string" ? header.alg : undefined,
            expiresAt: toIso(claims.exp),
            notBefore: toIso(claims.nbf),
            issuedAt: toIso(claims.iat),
            findings,
            claimFindings,
            source: "exchange",
            checkedAt,
          };

          context.logger.info(
            "Code exchanged: valid={valid}, {errors} error(s), " +
              "{claimErrors} claim error(s)",
            {
              valid,
              errors: findings.filter((f) => f.severity === "error").length,
              claimErrors: claimFindings.filter((f) =>
                f.severity === "error"
              ).length,
            },
          );
          const handle = await context.writeResource("token", "token", data);
          return { dataHandles: [handle] };
        } catch (err) {
          const data: Record<string, unknown> = {
            issuer,
            valid: false,
            header: {},
            claims: {},
            findings: [{
              severity: "error",
              code: "exchange-error",
              message: `Token exchange request failed: ${errorMessage(err)}`,
            }],
            claimFindings: [],
            source: "exchange",
            checkedAt,
          };
          const handle = await context.writeResource("token", "token", data);
          return { dataHandles: [handle] };
        } finally {
          client?.close();
        }
      },
    },
    "resolve-groups": {
      description:
        "Expand an Entra groups-overage reference into the actual group list. " +
        "Mints its own Microsoft Graph token via a client-credentials grant " +
        "(client_id + client_secret from a vault; the app registration needs " +
        "Graph application permissions such as GroupMember.Read.All or " +
        "Directory.Read.All with admin consent), reads the _claim_sources " +
        "endpoint from the prior 'token' run, calls it, and writes a 'groups' " +
        "resource with the resolved membership. The secret is never stored.",
      arguments: z.object({
        clientId: z.string().describe(
          "The application (client) id used for the client-credentials grant.",
        ),
        clientSecret: z.string().meta({ sensitive: true }).describe(
          "The client secret; supply via a vault reference " +
            "(${{ vault.get(<vault>, <key>) }}).",
        ),
        graphScope: z.string().default(
          "https://graph.microsoft.com/.default",
        ).describe(
          "OAuth2 scope for the Graph token. Defaults to the Microsoft Graph " +
            "'.default' scope; override for Azure AD Graph if required.",
        ),
      }),
      execute: async (
        args: { clientId: string; clientSecret: string; graphScope: string },
        context: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { issuer } = context.globalArgs;
        const client = makeClient(context.globalArgs);
        const resolvedAt = new Date().toISOString();

        const fail = async (
          code: string,
          message: string,
          endpoint?: string,
        ) => {
          const data: Record<string, unknown> = {
            issuer,
            resolved: false,
            endpoint,
            count: 0,
            groups: [],
            findings: [{ severity: "error", code, message }],
            resolvedAt,
          };
          const handle = await context.writeResource("groups", "groups", data);
          return { dataHandles: [handle] };
        };

        // The overage endpoint lives in the prior token's _claim_sources.
        const priorToken = await context.readResource("token");
        const claims = priorToken?.claims as
          | Record<string, unknown>
          | undefined;
        const claimNames = claims?._claim_names as
          | Record<string, unknown>
          | undefined;
        const claimSources = claims?._claim_sources as
          | Record<string, { endpoint?: string }>
          | undefined;
        if (!claims || !claimNames || !claimSources) {
          return await fail(
            "no-overage",
            "No groups-overage reference found. Run exchange-code (or " +
              "decode-token) first on a token that has _claim_names/" +
              "_claim_sources for 'groups'.",
          );
        }
        const sourceKey = typeof claimNames.groups === "string"
          ? claimNames.groups
          : undefined;
        const endpoint = sourceKey
          ? claimSources[sourceKey]?.endpoint
          : undefined;
        if (!endpoint) {
          return await fail(
            "overage-endpoint-missing",
            "The token has a groups _claim_names entry but no matching " +
              "_claim_sources endpoint.",
          );
        }

        // Resolve the token endpoint from discovery for the Graph token grant.
        const priorDiscovery = await context.readResource("discovery");
        const tokenEndpoint = typeof priorDiscovery?.tokenEndpoint === "string"
          ? priorDiscovery.tokenEndpoint
          : undefined;
        if (!tokenEndpoint) {
          return await fail(
            "token-endpoint-unknown",
            "No token endpoint available for the client-credentials grant. " +
              "Run 'discover' first.",
            endpoint,
          );
        }

        try {
          // 1. Client-credentials grant for a Graph token.
          const grantForm = new URLSearchParams({
            grant_type: "client_credentials",
            client_id: args.clientId,
            client_secret: args.clientSecret,
            scope: args.graphScope,
          });
          const timeout1 = AbortSignal.timeout(context.globalArgs.timeoutMs);
          const combined1 = AbortSignal.any([context.signal, timeout1]);
          const grantInit: RequestInit & { client?: Deno.HttpClient } = {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              Accept: "application/json",
            },
            body: grantForm.toString(),
            signal: combined1,
          };
          if (client) grantInit.client = client;

          context.logger.info("Minting Graph token at {endpoint}", {
            endpoint: tokenEndpoint,
          });
          const grantResp = await fetch(tokenEndpoint, grantInit);
          const grantRaw = await grantResp.text().catch(() => "");
          let grantBody: Record<string, unknown> = {};
          try {
            grantBody = grantRaw ? JSON.parse(grantRaw) : {};
          } catch {
            grantBody = {};
          }
          if (!grantResp.ok) {
            const oauthErr = typeof grantBody.error === "string"
              ? grantBody.error
              : `http_${grantResp.status}`;
            const desc = typeof grantBody.error_description === "string"
              ? grantBody.error_description
              : truncateBody(grantRaw);
            return await fail(
              `graph-grant-${oauthErr}`,
              `Client-credentials grant for a Graph token failed ` +
                `(${oauthErr}): ${desc}. The app registration likely lacks ` +
                `Graph application permissions with admin consent.`,
              endpoint,
            );
          }
          const graphToken = typeof grantBody.access_token === "string"
            ? grantBody.access_token
            : undefined;
          if (!graphToken) {
            return await fail(
              "graph-token-absent",
              "Client-credentials grant succeeded but returned no " +
                "access_token.",
              endpoint,
            );
          }

          // 2. Call the overage endpoint. Entra still advertises the retired
          //    Azure AD Graph host; rewrite it to Microsoft Graph. A
          //    getMemberObjects endpoint is a POST with a body; a memberOf-style
          //    collection endpoint is a GET.
          const normalized = normalizeOverageEndpoint(endpoint);
          const resolveFindings: Finding[] = [];
          if (normalized.rewritten) {
            resolveFindings.push({
              severity: "info",
              code: "overage-endpoint-rewritten",
              message:
                "The token's _claim_sources pointed at the retired Azure AD " +
                "Graph host (graph.windows.net), where getMemberObjects is now " +
                "blocked. Rewrote the call to Microsoft Graph " +
                "(graph.microsoft.com/v1.0).",
            });
          }
          const isPost = normalized.url.includes("getMemberObjects");
          const timeout2 = AbortSignal.timeout(context.globalArgs.timeoutMs);
          const combined2 = AbortSignal.any([context.signal, timeout2]);
          const callInit: RequestInit & { client?: Deno.HttpClient } = {
            method: isPost ? "POST" : "GET",
            headers: {
              Authorization: `Bearer ${graphToken}`,
              Accept: "application/json",
              ...(isPost ? { "Content-Type": "application/json" } : {}),
            },
            body: isPost
              ? JSON.stringify({ securityEnabledOnly: false })
              : undefined,
            signal: combined2,
          };
          if (client) callInit.client = client;

          context.logger.info("Resolving groups from {endpoint}", {
            endpoint: normalized.url,
          });
          const resp = await fetch(normalized.url, callInit);
          const raw = await resp.text().catch(() => "");
          if (!resp.ok) {
            return await fail(
              "overage-resolve-failed",
              `Graph overage endpoint returned ${resp.status}: ${
                truncateBody(raw)
              }`,
              endpoint,
            );
          }
          let body: Record<string, unknown> = {};
          try {
            body = raw ? JSON.parse(raw) : {};
          } catch {
            body = {};
          }
          // Both shapes return the ids under "value".
          const value = Array.isArray(body.value) ? body.value : [];
          const groups = value.filter(
            (g): g is string => typeof g === "string",
          );

          const findings: Finding[] = [...resolveFindings];
          if (groups.length === 0) {
            findings.push({
              severity: "info",
              code: "groups-empty",
              message:
                "The overage endpoint returned no group ids for this user.",
            });
          }

          const data: Record<string, unknown> = {
            issuer,
            resolved: true,
            endpoint,
            count: groups.length,
            groups,
            findings,
            resolvedAt,
          };
          context.logger.info("Resolved {count} group(s)", {
            count: groups.length,
          });
          const handle = await context.writeResource("groups", "groups", data);
          return { dataHandles: [handle] };
        } catch (err) {
          return await fail(
            "resolve-groups-error",
            `Resolving groups failed: ${errorMessage(err)}`,
            endpoint,
          );
        } finally {
          client?.close();
        }
      },
    },
  },
};
