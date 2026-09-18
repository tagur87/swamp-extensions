# `@tagur/meraki`

A read-only
[Cisco Meraki Dashboard API v1](https://developer.cisco.com/meraki/api-v1/)
model. It reads organization inventory and status — organizations, networks,
devices, device reachability, licenses, WAN uplinks, and clients — and stores
every record as its own versioned swamp resource, so a fleet can be queried with
CEL and diffed across runs.

Nothing is ever written back to the Dashboard. Every method is a GET, including
the `request` escape hatch.

## One model, many organizations

`profiles` maps a friendly name to an organization ID and **its own API key**,
so a single model instance covers organizations that do not share credentials.
Each method fans out over every profile in one run, which acquires the per-model
lock once instead of contending across separate runs per org.

Every stored record carries the `profile` and `organizationId` it came from, so
cross-org data stays attributable in a single CEL query.

## Install

```bash
swamp extension pull @tagur/meraki
```

## Configure

API keys are credentials — keep them in a vault and reference them with
`vault.get`:

```bash
swamp vault create local_encryption meraki
swamp vault put meraki CORP_API_KEY   # prompts, value stays out of shell history
swamp vault put meraki LAB_API_KEY

swamp model create @tagur/meraki meraki
```

Then set `globalArguments` in `models/@tagur/meraki/meraki.yaml`:

```yaml
globalArguments:
  profiles:
    corp:
      organizationId: "549236"
      apiKey: ${{ vault.get("meraki", "CORP_API_KEY") }}
    lab:
      organizationId: "681155"
      apiKey: ${{ vault.get("meraki", "LAB_API_KEY") }}
```

Omit `organizationId` to have the profile cover **every** organization its key
can see — discovered via `GET /organizations` at run time:

```yaml
globalArguments:
  profiles:
    all-orgs:
      apiKey: ${{ vault.get("meraki", "CORP_API_KEY") }}
```

### Global arguments

| Argument             | Default                         | Purpose                                                       |
| -------------------- | ------------------------------- | ------------------------------------------------------------- |
| `profiles`           | _(required)_                    | Named profiles: `apiKey`, optional `organizationId`/`baseUrl` |
| `baseUrl`            | `https://api.meraki.com/api/v1` | Default API base for profiles that don't override it          |
| `perPage`            | `1000`                          | Entries requested per page                                    |
| `maxPages`           | `50`                            | Page cap per endpoint per org (reported as `truncated`)       |
| `maxRetries`         | `4`                             | Retries for 429 and 5xx responses                             |
| `includeLicenseKeys` | `false`                         | Store `licenseKey` on license records                         |

A per-profile `baseUrl` targets a regional dashboard (for example
`https://api.meraki.cn/api/v1`) without splitting the model.

## Run

```bash
# Every profile
swamp model @tagur/meraki method run sync_devices meraki

# One profile
swamp model @tagur/meraki method run sync_devices meraki --input profile=lab

# Filtered
swamp model @tagur/meraki method run sync_devices meraki \
  --input productTypes='["appliance","switch"]'

# Clients need explicit network IDs — run sync_networks first to discover them
swamp model @tagur/meraki method run sync_clients meraki \
  --input networkIds='["N_24329156"]' --input timespan=86400
```

## Methods

| Method                 | Endpoint                                | Spec              |
| ---------------------- | --------------------------------------- | ----------------- |
| `sync_organizations`   | `/organizations`                        | `organization`    |
| `sync_networks`        | `/organizations/{id}/networks`          | `network`         |
| `sync_devices`         | `/organizations/{id}/devices`           | `device`          |
| `sync_device_statuses` | `/organizations/{id}/devices/statuses`  | `deviceStatus`    |
| `sync_licenses`        | `/organizations/{id}/licenses`          | `license`         |
| ↳ co-term fallback     | `/organizations/{id}/licenses/overview` | `licenseOverview` |
| `sync_uplink_statuses` | `/organizations/{id}/uplinks/statuses`  | `uplinkStatus`    |
| `sync_clients`         | `/networks/{networkId}/clients`         | `client`          |
| `request`              | any v1 path                             | `response`        |

Record schemas declare the fields worth querying and pass the rest of each
payload through unchanged, so nothing the API returns is discarded.

### Licensing models

`/organizations/{id}/licenses` returns per-device licenses and answers HTTP 400
for an organization on co-termination licensing. `sync_licenses` treats that as
a statement about the licensing model rather than a fault: it retries against
`/licenses/overview` and stores the co-term summary (status, expiration,
licensed device counts) as a `licenseOverview` record, counted as success. Only
that specific 400 — the documented "does not support per-device licensing"
message — triggers the fallback; any other 400 still fails the organization.

So a mixed fleet yields `license` records for per-device orgs and
`licenseOverview` records for co-term ones, from a single run:

```bash
swamp data query 'modelName == "meraki" && specName == "licenseOverview"' \
  --select '{"org": attributes.organizationId, "status": attributes.status, "expires": attributes.expirationDate}'
```

### `request` — escape hatch

For any endpoint without a typed method. `{organizationId}` is substituted per
profile, and `paginate` follows `Link` headers and stores the combined array:

```bash
swamp model @tagur/meraki method run request meraki \
  --input path='organizations/{organizationId}/admins'

swamp model @tagur/meraki method run request meraki \
  --input path='organizations/{organizationId}/appliance/vpn/statuses' \
  --input paginate=true
```

## Snapshots — what a run actually did

Every method writes one `snapshot` resource per profile:

```jsonc
{
  "method": "sync_devices",
  "profile": "corp",
  "organizationIds": ["549236"],
  "count": 412,
  "requests": 2,
  "truncated": false,
  "errors": [],
  "syncedAt": "2026-09-17T22:14:03.118Z"
}
```

A run that reaches some organizations and not others is **not** a failed run:
the records that came back are stored, the failures land in that profile's
`errors` with their HTTP status, and a `warning` is logged. A run only fails
outright when it produced nothing at all. This keeps one co-terminated or
permission-limited org from masking the rest of the fleet — and makes the
failure assertable:

```bash
swamp data query 'modelName == "meraki" && specName == "snapshot"' \
  --select '{"profile": attributes.profile, "errors": attributes.errors}'
```

`truncated` is `true` whenever `maxPages` stopped the walk early, so a partial
result set is never reported as complete.

## Querying the data

```bash
# Devices offline across every organization
swamp data query 'modelName == "meraki" && specName == "deviceStatus"' \
  --select '{"serial": attributes.serial, "org": attributes.organizationId, "status": attributes.status}'

# Licenses expiring, one organization
swamp data query 'modelName == "meraki" && specName == "license" && attributes.profile == "corp"' \
  --select '{"type": attributes.licenseType, "expires": attributes.expirationDate}'
```

## Rate limits and pagination

The Dashboard API allows
[10 requests/second per organization](https://developer.cisco.com/meraki/api-v1/rate-limit/).
Requests are issued sequentially per organization; a 429 is retried after the
`Retry-After` interval, falling back to exponential backoff when the header is
absent or unparseable, and 5xx responses back off the same way. Permanent errors
(401, 403, 404, 400) are not retried — they surface immediately with the status
and response body.

[Pagination](https://developer.cisco.com/meraki/api-v1/pagination/) follows the
RFC5988 `Link: rel=next` chain to completion, bounded by `maxPages`.

## Credentials

- Keys are read from `globalArguments.profiles[*].apiKey` — use a vault
  expression rather than a literal.
- Keys never appear in logs or error messages; URLs are stripped of query
  parameters before being logged.
- `licenseKey` is dropped from license records unless
  `includeLicenseKeys: true`, since a license key is itself a credential.
- Use a read-only Dashboard admin role — every method here is a GET.

## Pre-flight checks

| Check                 | Label    | Verifies                                     |
| --------------------- | -------- | -------------------------------------------- |
| `profiles-configured` | `policy` | At least one profile, none with an empty key |
| `api-reachable`       | `live`   | Every profile's key authenticates            |

Skip the live check in offline environments with `--skip-check-label live`.

## Development

```bash
~/.swamp/deno/deno check meraki.ts
~/.swamp/deno/deno test --allow-all meraki_test.ts
```

## License

MIT — see [LICENSE.md](LICENSE.md).
