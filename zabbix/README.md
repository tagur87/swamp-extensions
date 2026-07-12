# swamp-extensions

Extensions for [swamp](https://github.com/swamp-club/swamp).

## `@tagur/zabbix`

A read-only [Zabbix](https://www.zabbix.com/) JSON-RPC model. It fetches trend
(hourly min/avg/max) or raw history time-series for items across a host group,
matching hosts by name regex — the same shape of query the Grafana Zabbix
datasource runs, but captured as versioned, scriptable swamp data.

All methods are **read-only** against Zabbix. Nothing is ever written back;
results are persisted only in swamp's local datastore.

### Install

```bash
swamp extension pull @tagur/zabbix
```

### Configure

The token is only used by the data methods (`apiinfo.version` needs none). Store
it in a vault and reference it with `vault.get`:

```bash
swamp vault create local_encryption zabbix
swamp vault put zabbix ZABBIX_TOKEN=<your-api-token>

swamp model create @tagur/zabbix mon \
  --global-arg endpoint=https://zabbix.example.com/zabbix/api_jsonrpc.php \
  --global-arg 'token=${{ vault.get("zabbix", "ZABBIX_TOKEN") }}'
```

#### Global arguments

| Arg | Required | Default | Description |
| --- | --- | --- | --- |
| `endpoint` | yes | — | Zabbix JSON-RPC endpoint URL (`.../api_jsonrpc.php`) |
| `token` | yes | — | Zabbix API token (sensitive) |
| `authStyle` | no | `bearer` | `bearer` (Authorization header, Zabbix 6.4+) or `body` (auth field, 5.4–6.2) |
| `caCert` | no | — | PEM CA certificate for internal/self-signed TLS endpoints |

### Methods

| Method | Reads | Output specs | Purpose |
| --- | --- | --- | --- |
| `server_info` | `apiinfo.version` | `server` | Report the Zabbix server version (no auth) |
| `discover` | `hostgroup/host/item.get` | `discovery` | List matching hosts and items (with current values) to verify names |
| `trends` | + `trend.get` / `history.get` | `series`, `summary` | Per-host time-series, one `series` resource per host, plus a `summary` |

#### `trends` arguments

| Arg | Default | Description |
| --- | --- | --- |
| `hostGroup` | `Servers - Remote Access` | Zabbix host group (exact name) |
| `hostFilter` | `.*ra0.*` | Regex matched against host names |
| `itemName` | `Concurrent Users` | Item name to match |
| `match` | `exact` | `exact` (name equals) or `contains` (substring) |
| `days` | `30` | Days of history to fetch, ending now |
| `source` | `trends` | `trends` (hourly aggregates) or `history` (raw values) |

### Example

```bash
swamp model method run mon server_info
swamp model method run mon discover
swamp model method run mon trends --input days=30

swamp data query 'modelName == "mon" && specName == "summary"' --json
swamp data query 'modelName == "mon" && specName == "series"' \
  --select '{"host": attributes.host, "peak": attributes.peak}'
```

### TLS with an internal CA

Swamp models run in Deno, whose `fetch` cannot skip certificate verification.
For endpoints behind a private CA, pass the CA's PEM via the `caCert` global
argument (a root CA certificate is public and safe to commit):

```yaml
globalArguments:
  caCert: |
    -----BEGIN CERTIFICATE-----
    ...
    -----END CERTIFICATE-----
```

## License

MIT — see [LICENSE.md](LICENSE.md).
