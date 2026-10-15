/**
 * Unit tests for @tagur/oidc-diagnose pure helpers.
 *
 * @module
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  base64UrlDecode,
  discoveryUrl,
  validateDiscovery,
  validateToken,
} from "./oidc-diagnose.ts";

function codes(findings: Array<{ code: string }>): string[] {
  return findings.map((f) => f.code).sort();
}

Deno.test("discoveryUrl appends well-known path and strips trailing slashes", () => {
  assertEquals(
    discoveryUrl("https://login.example.com"),
    "https://login.example.com/.well-known/openid-configuration",
  );
  assertEquals(
    discoveryUrl("https://login.example.com/"),
    "https://login.example.com/.well-known/openid-configuration",
  );
  assertEquals(
    discoveryUrl("https://ex.com/oauth2/default//"),
    "https://ex.com/oauth2/default/.well-known/openid-configuration",
  );
});

Deno.test("base64UrlDecode handles unpadded base64url", () => {
  // {"alg":"RS256"} base64url-encoded, no padding
  const encoded = btoa('{"alg":"RS256"}').replace(/=+$/, "")
    .replace(/\+/g, "-").replace(/\//g, "_");
  assertEquals(JSON.parse(base64UrlDecode(encoded)).alg, "RS256");
});

Deno.test("base64UrlDecode decodes real JWT header segment", () => {
  // Header for {"alg":"RS256","typ":"JWT","kid":"abc"}
  const seg = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6ImFiYyJ9";
  const header = JSON.parse(base64UrlDecode(seg));
  assertEquals(header.alg, "RS256");
  assertEquals(header.kid, "abc");
});

Deno.test("validateDiscovery passes a healthy document", () => {
  const findings = validateDiscovery("https://idp.example.com", {
    issuer: "https://idp.example.com",
    authorization_endpoint: "https://idp.example.com/authorize",
    token_endpoint: "https://idp.example.com/token",
    jwks_uri: "https://idp.example.com/jwks",
    userinfo_endpoint: "https://idp.example.com/userinfo",
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["openid", "profile", "email"],
  });
  assertEquals(findings.filter((f) => f.severity === "error").length, 0);
  assertEquals(findings.length, 0);
});

Deno.test("validateDiscovery flags issuer mismatch as error", () => {
  const findings = validateDiscovery("https://idp.example.com", {
    issuer: "https://other.example.com",
    authorization_endpoint: "https://x/authorize",
    token_endpoint: "https://x/token",
    jwks_uri: "https://x/jwks",
    userinfo_endpoint: "https://x/userinfo",
    code_challenge_methods_supported: ["S256"],
  });
  assert(findings.some((f) => f.code === "issuer-mismatch" && f.severity === "error"));
});

Deno.test("validateDiscovery tolerates trailing-slash issuer difference", () => {
  const findings = validateDiscovery("https://idp.example.com/", {
    issuer: "https://idp.example.com",
    authorization_endpoint: "https://x/authorize",
    token_endpoint: "https://x/token",
    jwks_uri: "https://x/jwks",
    userinfo_endpoint: "https://x/userinfo",
    code_challenge_methods_supported: ["S256"],
  });
  assert(!findings.some((f) => f.code === "issuer-mismatch"));
});

Deno.test("validateDiscovery flags missing required endpoints", () => {
  const findings = validateDiscovery("https://idp.example.com", {
    issuer: "https://idp.example.com",
  });
  const endpointFindings = findings.filter((f) => f.code === "endpoint-missing");
  assertEquals(endpointFindings.length, 3); // authorization, token, jwks
  assert(endpointFindings.every((f) => f.severity === "error"));
});

Deno.test("validateDiscovery warns on absent PKCE and plain-only PKCE", () => {
  const noPkce = validateDiscovery("https://idp.example.com", {
    issuer: "https://idp.example.com",
    authorization_endpoint: "https://x/a",
    token_endpoint: "https://x/t",
    jwks_uri: "https://x/j",
    userinfo_endpoint: "https://x/u",
  });
  assert(noPkce.some((f) => f.code === "pkce-unadvertised" && f.severity === "warning"));

  const plainOnly = validateDiscovery("https://idp.example.com", {
    issuer: "https://idp.example.com",
    authorization_endpoint: "https://x/a",
    token_endpoint: "https://x/t",
    jwks_uri: "https://x/j",
    userinfo_endpoint: "https://x/u",
    code_challenge_methods_supported: ["plain"],
  });
  assert(plainOnly.some((f) => f.code === "pkce-no-s256"));
});

Deno.test("validateDiscovery warns when openid scope missing", () => {
  const findings = validateDiscovery("https://idp.example.com", {
    issuer: "https://idp.example.com",
    authorization_endpoint: "https://x/a",
    token_endpoint: "https://x/t",
    jwks_uri: "https://x/j",
    userinfo_endpoint: "https://x/u",
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["profile", "email"],
  });
  assert(findings.some((f) => f.code === "openid-scope-missing"));
});

const now = 1_700_000_000; // fixed reference "now"

Deno.test("validateToken passes a healthy token", () => {
  const findings = validateToken(
    { alg: "RS256", kid: "key-1" },
    {
      iss: "https://idp.example.com",
      aud: "client-123",
      exp: now + 3600,
      nbf: now - 10,
      iat: now - 10,
    },
    {
      issuer: "https://idp.example.com",
      skewSeconds: 120,
      nowSeconds: now,
      expectedAudience: "client-123",
      jwksKids: ["key-1", "key-2"],
    },
  );
  assertEquals(findings.filter((f) => f.severity === "error").length, 0);
});

Deno.test("validateToken flags expired token", () => {
  const findings = validateToken(
    { alg: "RS256", kid: "key-1" },
    { iss: "https://idp.example.com", exp: now - 3600 },
    { issuer: "https://idp.example.com", skewSeconds: 120, nowSeconds: now, jwksKids: ["key-1"] },
  );
  assert(findings.some((f) => f.code === "token-expired" && f.severity === "error"));
});

Deno.test("validateToken honours clock skew on exp boundary", () => {
  // Expired 60s ago, but skew is 120s → within tolerance, no finding.
  const findings = validateToken(
    { alg: "RS256", kid: "key-1" },
    { iss: "https://idp.example.com", exp: now - 60 },
    { issuer: "https://idp.example.com", skewSeconds: 120, nowSeconds: now, jwksKids: ["key-1"] },
  );
  assert(!findings.some((f) => f.code === "token-expired"));
});

Deno.test("validateToken flags unknown kid against JWKS", () => {
  const findings = validateToken(
    { alg: "RS256", kid: "rotated-out" },
    { iss: "https://idp.example.com", exp: now + 3600 },
    { issuer: "https://idp.example.com", skewSeconds: 120, nowSeconds: now, jwksKids: ["key-1", "key-2"] },
  );
  assert(findings.some((f) => f.code === "kid-unknown" && f.severity === "error"));
});

Deno.test("validateToken flags alg none", () => {
  const findings = validateToken(
    { alg: "none" },
    { iss: "https://idp.example.com", exp: now + 3600 },
    { issuer: "https://idp.example.com", skewSeconds: 120, nowSeconds: now },
  );
  assert(findings.some((f) => f.code === "alg-none" && f.severity === "error"));
});

Deno.test("validateToken flags issuer mismatch", () => {
  const findings = validateToken(
    { alg: "RS256" },
    { iss: "https://evil.example.com", exp: now + 3600 },
    { issuer: "https://idp.example.com", skewSeconds: 120, nowSeconds: now },
  );
  assert(findings.some((f) => f.code === "iss-mismatch" && f.severity === "error"));
});

Deno.test("validateToken flags audience mismatch and missing audience", () => {
  const mismatch = validateToken(
    { alg: "RS256" },
    { iss: "https://idp.example.com", aud: ["other-client"], exp: now + 3600 },
    { issuer: "https://idp.example.com", skewSeconds: 120, nowSeconds: now, expectedAudience: "my-client" },
  );
  assert(mismatch.some((f) => f.code === "aud-mismatch" && f.severity === "error"));

  const missing = validateToken(
    { alg: "RS256" },
    { iss: "https://idp.example.com", exp: now + 3600 },
    { issuer: "https://idp.example.com", skewSeconds: 120, nowSeconds: now, expectedAudience: "my-client" },
  );
  assert(missing.some((f) => f.code === "aud-missing" && f.severity === "error"));
});

Deno.test("validateToken accepts string aud matching expected", () => {
  const findings = validateToken(
    { alg: "RS256" },
    { iss: "https://idp.example.com", aud: "my-client", exp: now + 3600 },
    { issuer: "https://idp.example.com", skewSeconds: 120, nowSeconds: now, expectedAudience: "my-client" },
  );
  assert(!findings.some((f) => f.code.startsWith("aud-")));
});

Deno.test("validateToken flags not-yet-valid nbf and future iat", () => {
  const findings = validateToken(
    { alg: "RS256" },
    { iss: "https://idp.example.com", exp: now + 7200, nbf: now + 3600, iat: now + 3600 },
    { issuer: "https://idp.example.com", skewSeconds: 120, nowSeconds: now },
  );
  assertEquals(
    codes(findings.filter((f) => ["token-not-yet-valid", "iat-future"].includes(f.code))),
    ["iat-future", "token-not-yet-valid"],
  );
});

Deno.test("validateToken warns on missing exp and missing iss", () => {
  const findings = validateToken(
    { alg: "RS256" },
    {},
    { issuer: "https://idp.example.com", skewSeconds: 120, nowSeconds: now },
  );
  assert(findings.some((f) => f.code === "exp-missing" && f.severity === "warning"));
  assert(findings.some((f) => f.code === "iss-missing" && f.severity === "warning"));
});
