# @tagur/oidc-diagnose

IdP-agnostic OpenID Connect diagnostics for [swamp](https://github.com/swamp-club/swamp).
Read-only troubleshooting of broken login flows against any standards-compliant
provider — Okta, Auth0, Entra ID, Keycloak, Zitadel, Cognito, Google, and more.

It exercises only the OpenID Connect Discovery and JWT standards, so it works
the same everywhere and needs **no credentials and no vault**.

## Why

When an OIDC login breaks, the failure is almost always one of a handful of
things: the discovery document is wrong or unreachable, the issuer doesn't
match, a required endpoint is missing, PKCE isn't advertised, the signing key
rotated, or the token is expired / has the wrong audience. This model turns each
of those into an explicit, queryable finding instead of a stack trace.

Each method writes a diagnostic resource **even when the probe fails**, so a
broken endpoint still leaves a truthful record you can inspect and diff over
time.

## Methods

| Method         | What it does                                                                                              |
| -------------- | --------------------------------------------------------------------------------------------------------- |
| `discover`     | Fetch `<issuer>/.well-known/openid-configuration` and validate it: issuer match, required endpoints, PKCE methods, scopes, grant types. |
| `jwks`         | Fetch the provider JWKS and report each key's `kid`, `kty`, `alg`, `use`. Resolves the URI from a prior `discover` run or the `jwksUri` argument. |
| `decode-token` | Decode a JWT (header + claims) and sanity-check `alg`, `kid`, `iss`, `aud`, `exp`, `nbf`, `iat`. |

> **Signature verification:** `decode-token` decodes and inspects claims; it
> does **not** cryptographically verify the JWT signature. It does flag when the
> token's `kid` is absent from the discovered JWKS (the usual key-rotation
> failure) and when `alg` is `none`.

## Global arguments

| Argument           | Required | Default | Description                                                      |
| ------------------ | -------- | ------- | ---------------------------------------------------------------- |
| `issuer`           | yes      | —       | OIDC issuer / provider base URL.                                 |
| `timeoutMs`        | no       | `15000` | Per-request HTTP timeout in milliseconds.                        |
| `clockSkewSeconds` | no       | `120`   | Allowed clock skew when checking `exp` / `nbf` / `iat`.          |
| `caCert`           | no       | —       | PEM CA certificate for internal / self-signed TLS endpoints.     |

## Quick start

```bash
swamp extension pull @tagur/oidc-diagnose

swamp behavior create @tagur/oidc-diagnose login-check \
  --global-arg issuer=https://login.example.com

# 1. Validate the provider's discovery document
swamp behavior run login-check discover

# 2. Fetch the JWKS (URI resolved from the discover run)
swamp behavior run login-check jwks

# 3. Decode a token and check its claims against the clock + JWKS
swamp behavior run login-check decode-token \
  --arg token=<jwt> --arg expectedAudience=<client-id>
```

## Reading the results

Each run stores a resource (`discovery`, `jwks`, or `token`) carrying a
`findings` array. Query the findings across every probe:

```bash
swamp data query 'behavior("login-check")' \
  --select '{"spec": tags.specName, "findings": attributes.findings}'
```

Filter to just the blocking problems:

```bash
swamp data query 'behavior("login-check") && name == "discovery"' \
  --select 'attributes.findings'
```

## Composing with CEL

`discover` captures the resolved endpoints, so downstream wiring never
re-types them:

```
data.latest("login-check", "discovery").attributes.tokenEndpoint
data.latest("login-check", "discovery").attributes.jwksUri
```

The `jwks` and `decode-token` methods already read the prior `discovery` and
`jwks` resources automatically — run them in order against the same behavior and
the key ids flow through to token validation.

## Finding codes

`discover`: `discovery-unreachable`, `discovery-not-json`, `issuer-missing`,
`issuer-mismatch`, `endpoint-missing`, `userinfo-missing`, `pkce-unadvertised`,
`pkce-no-s256`, `openid-scope-missing`.

`jwks`: `jwks-uri-unknown`, `jwks-unreachable`, `jwks-empty`,
`kid-absent-multikey`.

`decode-token`: `token-malformed`, `token-undecodable`, `alg-missing`,
`alg-none`, `kid-missing`, `kid-unknown`, `iss-missing`, `iss-mismatch`,
`aud-missing`, `aud-mismatch`, `exp-missing`, `token-expired`,
`token-not-yet-valid`, `iat-future`.

## License

MIT — see [LICENSE.md](LICENSE.md).
