# @tagur/netbox

Generic NetBox REST API integration model for [swamp](https://github.com/swamp-club/swamp).

Works with any NetBox instance and any API endpoint. Fetches objects via the
REST API and stores each as a separately addressable resource using the factory
pattern — enabling CEL queries, cross-model composition, and drift detection
via versioned snapshots.

## Methods

| Method | Description |
|--------|-------------|
| `sync` | Fetch all objects from the configured endpoint with pagination and filters |
| `get`  | Fetch a single object by ID |

## Quick Start

```bash
swamp extension pull @tagur/netbox
swamp vault create local_encryption netbox
swamp vault put netbox NETBOX_TOKEN=<your-api-token>

# Create a model for sites
swamp model create @tagur/netbox sites \
  --global-arg url=https://nsot.example.com \
  --global-arg 'token=${{ vault.get("netbox", "NETBOX_TOKEN") }}' \
  --global-arg endpoint=dcim/sites

# Sync all sites
swamp model method run sites sync

# Query synced data
swamp data query 'modelName == "sites"' \
  --select '{"name": name, "status": attributes.status}'
```

## Filtering

Pass query-parameter filters as global args or per-sync overrides:

```bash
# Global filters applied to every sync
swamp model create @tagur/netbox active-sites \
  --global-arg url=https://nsot.example.com \
  --global-arg 'token=${{ vault.get("netbox", "NETBOX_TOKEN") }}' \
  --global-arg endpoint=dcim/sites \
  --global-arg 'filters={"region": "amer", "status": "active"}'

# Override filters for a single run
swamp model method run active-sites sync \
  --input 'filters={"status": "planned"}'
```

## Global Arguments

| Argument   | Required | Default | Description |
|------------|----------|---------|-------------|
| `url`      | yes      | —       | NetBox base URL (e.g. `https://nsot.example.com`) |
| `token`    | yes      | —       | NetBox API token (stored securely via vault) |
| `endpoint` | yes      | —       | REST API path relative to `/api/` (e.g. `dcim/sites`, `ipam/prefixes`) |
| `filters`  | no       | —       | Query parameter filters (e.g. `{region: 'amer', status: 'active'}`) |
| `pageSize` | no       | 200     | Results per page for paginated requests (1–1000) |
| `caCert`   | no       | —       | PEM CA certificate for internal/self-signed TLS endpoints |

## Resources

| Resource   | Description |
|------------|-------------|
| `item`     | Individual NetBox object fetched from the API |
| `snapshot` | Sync metadata — endpoint, filter, count, and timing |

## Self-signed TLS

For internal NetBox instances behind a self-signed certificate, supply the CA
cert as a global argument:

```bash
swamp model create @tagur/netbox internal-sites \
  --global-arg url=https://nsot.internal.example.com \
  --global-arg 'token=${{ vault.get("netbox", "NETBOX_TOKEN") }}' \
  --global-arg endpoint=dcim/sites \
  --global-arg "caCert=$(cat /path/to/ca.pem)"
```

## License

MIT
