# @tagur/oidc-diagnose

IdP-agnostic OpenID Connect diagnostics for [swamp](https://github.com/swamp-club/swamp).
Read-only troubleshooting of broken login flows against any standards-compliant
provider — Okta, Auth0, Entra ID, Keycloak, Zitadel, Cognito, Google, and more.

It exercises only the OpenID Connect Discovery, token, and JWT standards, so it
works the same everywhere. The read-only methods need **no credentials and no
vault**; only `exchange-code` needs a client secret, supplied through a vault.

## Why

When an OIDC login breaks, the failure is almost always one of a handful of
things: the discovery document is wrong or unreachable, the issuer doesn't
match, a required endpoint is missing, PKCE isn't advertised, the signing key
rotated, the token is expired / has the wrong audience, or an expected claim
(`groups`, `email`, `roles`) isn't present. This model turns each of those into
an explicit, queryable finding instead of a stack trace.

Each method writes a diagnostic resource **even when the probe fails**, so a
broken endpoint still leaves a truthful record you can inspect and diff over
time.

## Methods

| Method          | What it does                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| `discover`      | Fetch `<issuer>/.well-known/openid-configuration` and validate it: issuer match, required endpoints, PKCE methods, scopes, grant types. |
| `jwks`          | Fetch the provider JWKS and report each key's `kid`, `kty`, `alg`, `use`. Resolves the URI from a prior `discover` run or the `jwksUri` argument. |
| `decode-token`  | Decode a JWT (header + claims) and sanity-check `alg`, `kid`, `iss`, `aud`, `exp`, `nbf`, `iat`. Optionally assert required claims are present. |
| `exchange-code` | Exchange an OAuth2 authorization `code` at the token endpoint (confidential client; secret from a vault), then decode and claim-check the returned `id_token`. |
| `resolve-groups`| Expand an Entra groups-overage reference: mint a Microsoft Graph token (client-credentials, secret from a vault) and call the `_claim_sources` endpoint from a prior token to fetch the real group list. |

> **Signature verification:** `decode-token` and `exchange-code` decode and
> inspect claims; they do **not** cryptographically verify the JWT signature.
> They do flag when the token's `kid` is absent from the discovered JWKS (the
> usual key-rotation failure) and when `alg` is `none`.

## Claim assertion

`decode-token` and `exchange-code` accept `requiredClaims` (claim names that
must be present and non-empty) and `expectedGroups` (values the `groups` claim
must include). Results land in a separate `claimFindings` array on the `token`
resource.

Entra's **groups overage** — where a user in too many groups gets no inline
`groups` claim, only `_claim_names`/`_claim_sources` pointers to Microsoft
Graph — is detected and reported as an **informational** `groups-overage`
finding. Because a consumer that resolves groups via Graph works fine with
overage, it *satisfies* a `groups` requirement by default. Set
`requireInlineGroups: true` when the consumer cannot call Graph and needs groups
inline; overage then becomes an error. Use `resolve-groups` to expand the
reference into the actual group list.

## Inspecting claims behind an auth proxy (oauth2-proxy / Skipper / Pomerium)

When an OIDC proxy fronts your app, the browser only ever gets an opaque session
cookie — the real tokens and user claims live server-side and never reach
DevTools. `exchange-code` reproduces that server-side exchange: you supply an
authorization `code` from one login, and the model performs the token exchange
and shows you the actual `id_token` claims (`groups`, `email`, `roles`, …).

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

## Exchanging an authorization code

```bash
# Store the client secret once (never on the command line / in YAML)
swamp vault put default OIDC_CLIENT_SECRET

swamp behavior run login-check exchange-code \
  --arg code=<authorization-code> \
  --arg clientId=<client-id> \
  --arg 'clientSecret=${{ vault.get(default, OIDC_CLIENT_SECRET) }}' \
  --arg redirectUri=https://app.example.com/authcallback \
  --arg 'requiredClaims=["groups","email","roles"]'
```

Run `discover` first so the token endpoint is resolved from stored data.

## Finding codes

`discover`: `discovery-unreachable`, `discovery-not-json`, `issuer-missing`,
`issuer-mismatch`, `endpoint-missing`, `userinfo-missing`, `pkce-unadvertised`,
`pkce-no-s256`, `openid-scope-missing`.

`jwks`: `jwks-uri-unknown`, `jwks-unreachable`, `jwks-empty`,
`kid-absent-multikey`.

`decode-token` / `exchange-code` (token checks): `token-malformed`,
`token-undecodable`, `alg-missing`, `alg-none`, `kid-missing`, `kid-unknown`,
`iss-missing`, `iss-mismatch`, `aud-missing`, `aud-mismatch`, `exp-missing`,
`token-expired`, `token-not-yet-valid`, `iat-future`.

Claim assertion (`claimFindings`): `claim-missing`, `groups-overage` (info by
default; error under `requireInlineGroups`), `groups-mismatch`.

`exchange-code` (exchange): `token-endpoint-unknown`, `exchange-<oauth-error>`
(e.g. `exchange-invalid_grant`, `exchange-redirect_uri_mismatch`,
`exchange-invalid_client`), `id-token-absent`, `exchange-error`.

`resolve-groups`: `no-overage`, `overage-endpoint-missing`,
`token-endpoint-unknown`, `graph-grant-<oauth-error>`, `graph-token-absent`,
`overage-resolve-failed`, `groups-empty`, `resolve-groups-error`.

## Resolving groups behind an overage (Entra)

When a token has a `groups-overage` reference, expand it to the real list:

```bash
# resolve-groups mints a Graph token via client-credentials and calls the
# _claim_sources endpoint from the prior exchange-code / decode-token run.
swamp behavior run login-check resolve-groups \
  --arg clientId=<client-id> \
  --arg 'clientSecret=${{ vault.get(default, OIDC_CLIENT_SECRET) }}'

swamp data query 'behavior("login-check") && name == "groups"' \
  --select '{"count": attributes.count, "groups": attributes.groups}'
```

The app registration must have Microsoft Graph **application** permissions
(e.g. `GroupMember.Read.All` or `Directory.Read.All`) with admin consent, or
the grant is rejected with a `graph-grant-*` finding.

## License

MIT — see [LICENSE.md](LICENSE.md).
