/**
 * IdP-agnostic OpenID Connect diagnostic model for swamp.
 *
 * Read-only troubleshooting for broken OIDC login flows. Works against any
 * standards-compliant provider (Okta, Auth0, Entra ID, Keycloak, Zitadel,
 * Cognito, Google, …) because it exercises only the OpenID Connect Discovery
 * and JWT standards — no provider-specific APIs, no credentials, no vault.
 *
 * Three methods:
 *   - discover:     fetch /.well-known/openid-configuration and validate it
 *                   (issuer match, required endpoints, PKCE, scopes, grants).
 *   - jwks:         fetch the JWKS and report key ids, algorithms, and usage.
 *   - decode-token: decode a JWT (header + claims, no signature verification)
 *                   and sanity-check iss / aud / exp / nbf / iat and the kid
 *                   against a previously discovered JWKS.
 *
 * Every method writes a diagnostic resource even when the probe fails, so a
 * broken endpoint still leaves a truthful, queryable record rather than only a
 * thrown error — the whole point of a troubleshooting tool.
 *
 * @module
 */
import { z } from "npm:zod@4";

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
  checkedAt: z.string(),
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

function toIso(seconds: unknown): string | undefined {
  return typeof seconds === "number"
    ? new Date(seconds * 1000).toISOString()
    : undefined;
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
export const behavior = {
  type: "@tagur/oidc-diagnose",
  version: "2026.10.15.1",
  globalArguments: GlobalArgsSchema,
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
        "run. Writes a 'token' resource with per-claim findings.",
      arguments: z.object({
        token: z.string().meta({ sensitive: true }).describe(
          "The JWT to decode (an access_token or id_token). Treated as " +
            "sensitive — stored claims are kept but the raw token is not.",
        ),
        expectedAudience: z.string().optional().describe(
          "Expected 'aud' value (the client_id or resource identifier). When " +
            "set, a mismatch is flagged as an error.",
        ),
      }),
      execute: async (
        args: { token: string; expectedAudience?: string },
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

        const valid = !findings.some((f) => f.severity === "error");
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
          checkedAt,
        };

        context.logger.info(
          "Token decoded: valid={valid}, {errors} error finding(s)",
          {
            valid,
            errors: findings.filter((f) => f.severity === "error").length,
          },
        );
        const handle = await context.writeResource("token", "token", data);
        return { dataHandles: [handle] };
      },
    },
  },
};
