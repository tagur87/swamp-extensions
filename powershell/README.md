# @tagur/powershell

Run PowerShell on remote Windows computers over WinRM (`Invoke-Command`)
from swamp. Any script block works: service checks, AD queries, config
changes, or calls into a custom session configuration.

- **Templated scripts.** `{{name}}` placeholders are filled from a
  `variables` map. Each value is inserted as a single-quoted PowerShell
  literal, so values are always data, never code.
- **Credentials from a vault.** The username and password reach PowerShell
  over stdin, never on the command line, and the password is never stored in
  results.
- **Versioned results.** Output is stored as a `result` resource with the
  formatted text and the objects as JSON, ready for CEL queries and
  workflows.

## Quick start

```bash
swamp extension pull @tagur/powershell

swamp vault create local_encryption powershell
printf '%s' 'EXAMPLE\admin' | swamp vault put powershell USERNAME
read -s P && printf '%s' "$P" | swamp vault put powershell PASSWORD; unset P

swamp model create @tagur/powershell ps
```

Set the global arguments in the model YAML (`models/@tagur/powershell/ps.yaml`):

```yaml
globalArguments:
  executable: pwsh
  authentication: Negotiate
  username: '${{ vault.get("powershell", "USERNAME") }}'
  password: '${{ vault.get("powershell", "PASSWORD") }}'
```

Run a command:

```bash
swamp model @tagur/powershell method run invoke ps \
  --input computerName=server01.example.com \
  --input 'script=Get-Service -Name {{svc}} | Select-Object Name, Status' \
  --input 'variables={"svc":"WinRM"}'
```

The host running the method needs PowerShell and a WinRM client. On Linux
and macOS that takes some setup; see
[Linux setup](#linux-setup-pwsh--wsman).

## Model: `@tagur/powershell`

### Global arguments

| Name             | Default   | Description                                                                              |
| ---------------- | --------- | ---------------------------------------------------------------------------------------- |
| `executable`     | `pwsh`    | Local PowerShell that runs `Invoke-Command`. Use `powershell.exe` on Windows.            |
| `username`       | —         | `-Credential` user (`DOMAIN\user` or `user@domain`). Omit to use the current identity.   |
| `password`       | —         | Sensitive. Use `${{ vault.get(...) }}`. Required when `username` is set.                 |
| `authentication` | `Default` | `Default`, `Negotiate`, `Kerberos`, `CredSSP` or `Basic`. Use `Negotiate` from Linux.    |
| `useSSL`         | `false`   | WinRM over HTTPS (port 5986).                                                            |
| `port`           | —         | WinRM port override.                                                                     |
| `timeoutSeconds` | `300`     | Kill the local PowerShell process after this many seconds.                               |

### Method: `invoke`

| Argument            | Required | Description                                              |
| ------------------- | -------- | -------------------------------------------------------- |
| `computerName`      | yes      | `-ComputerName`                                          |
| `configurationName` | no       | `-ConfigurationName` (custom session configuration)      |
| `script`            | yes      | Script block body, with optional `{{name}}` placeholders |
| `variables`         | no       | `{ name: value }` for the placeholders                   |
| `name`              | no       | Data instance name (default: `<host>-<config>` slug)     |

### Templating

```
script:    Restart-Service -Name {{svc}} -PassThru
variables: { svc: "Spooler" }
runs:      Restart-Service -Name 'Spooler' -PassThru
```

- Values are wrapped in single quotes, with any `'` inside doubled
  (including the typographic quotes PowerShell also accepts), so
  `'; Remove-Item ...` stays a plain string.
- `'{{name}}'` and `{{name}}` render identically, so an already-quoted
  command can be pasted as-is.
- Every placeholder must have a value. A missing one fails the run before
  anything executes.
- The rendered script contains only literals, so it also works on endpoints
  with a restricted language mode.

For anything that isn't a plain string (numbers, switches, script logic),
write it directly in `script`.

### Output: `result` resource

| Field                                           | Description                                         |
| ----------------------------------------------- | --------------------------------------------------- |
| `text`                                          | `Out-String` of the output                          |
| `objects`                                       | Output objects as JSON (`ConvertTo-Json -Depth 4`)  |
| `script`                                        | The rendered script that ran                        |
| `variables`                                     | The values used                                     |
| `computerName`, `configurationName`, `username` | Target and identity                                 |
| `startedAt`, `durationMs`                       | Timing                                              |

`script` and `variables` are stored in plain text, so don't pass secrets as
template variables. Credentials belong in the `username`/`password` global
arguments.

Errors from the remote side are raised with `-ErrorAction Stop`. A failed
run throws with the PowerShell error message and writes no data. If the
command succeeds but its output can't be converted to JSON, `objects` is
`null`, `text` is still stored, and a warning is logged.

### Using it in a workflow

```yaml
- name: check-service
  task:
    type: model_method
    modelIdOrName: ps
    methodName: invoke
    inputs:
      computerName: ${{ inputs.server }}
      script: Get-Service -Name {{svc}} | Select-Object Name, Status
      variables:
        svc: ${{ inputs.service }}
```

To run on a specific worker (for example, one inside the Windows network),
add `target: <worker-name>` to the step and run the workflow through
`swamp serve`: `swamp workflow run <wf> --server <serve-url>`.

## Linux setup (pwsh + WSMan)

On Linux (including WSL) and macOS, `Invoke-Command -ComputerName` needs
three things pwsh doesn't include: a WSMan client library, GSSAPI
authentication (Kerberos or NTLM), and DNS that resolves the domain. The
steps below are for Ubuntu and Debian, including a WSL distro. WSL interop
(`powershell.exe`) is not needed.

### 1. PowerShell 7

```bash
. /etc/os-release
sudo apt-get update
sudo apt-get install -y wget apt-transport-https software-properties-common
wget -q "https://packages.microsoft.com/config/${ID}/${VERSION_ID}/packages-microsoft-prod.deb" -O /tmp/ms.deb
sudo dpkg -i /tmp/ms.deb && rm /tmp/ms.deb
sudo apt-get update
sudo apt-get install -y powershell
pwsh --version
```

### 2. Kerberos, NTLM and DNS tools

```bash
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y krb5-user gss-ntlmssp dnsutils
```

- `krb5-user`: Kerberos libraries and `kinit`/`klist`
- `gss-ntlmssp`: NTLM through GSSAPI, the fallback when Kerberos isn't
  available
- `dnsutils`: `dig`, for checking domain DNS

### 3. WSMan client (PSWSMan)

pwsh on Linux doesn't ship a WSMan client that can authenticate against
Windows hosts. The PSWSMan module installs one. It needs `sudo` because it
writes into the pwsh install directory:

```bash
sudo pwsh -NoProfile -Command 'Install-Module PSWSMan -Scope AllUsers -Force; Install-WSMan'
```

A pwsh upgrade can replace the library, so re-run `Install-WSMan` if
remoting stops working after an upgrade.

### 4. Kerberos configuration

Replace `EXAMPLE.COM` / `example.com` with your AD realm and DNS domain.
KDCs are found through DNS SRV records, so none are hard-coded:

```bash
sudo tee /etc/krb5.conf >/dev/null <<'EOF'
[libdefaults]
  default_realm = EXAMPLE.COM
  dns_lookup_kdc = true
  dns_lookup_realm = false
  rdns = false
  forwardable = true
  dns_canonicalize_hostname = false

[domain_realm]
  .example.com = EXAMPLE.COM
  example.com = EXAMPLE.COM
EOF
```

### 5. DNS (WSL)

The host must resolve the domain's SRV records. WSL generates
`/etc/resolv.conf` from Windows, which may not include the domain DNS
servers. If the `dig` check below returns nothing, set
`generateResolvConf = false` under `[network]` in `/etc/wsl.conf`, point
`/etc/resolv.conf` at the domain DNS servers, and restart WSL
(`wsl --shutdown` from Windows).

### 6. Verify

```bash
dig +short _kerberos._tcp.example.com SRV   # lists domain controllers
kinit user@EXAMPLE.COM && klist             # Kerberos works
pwsh -NoProfile -Command '
  $c = Get-Credential "EXAMPLE\user"
  Invoke-Command -ComputerName server01.example.com -Authentication Negotiate -Credential $c -ScriptBlock { hostname }'
```

If the last command prints the remote host name, the model works on this
host. Set `authentication: Negotiate` in the model's global arguments.

### Troubleshooting

| Symptom                                                     | Fix                                                                                                                  |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `Invoke-Command` says no supported WSMan client was found   | PSWSMan isn't installed, or a pwsh upgrade replaced it. Re-run step 3.                                               |
| Errors mentioning `libmi` or `MI_Result`                    | The original WSMan library is still in use. Re-run `Install-WSMan` with `sudo`.                                      |
| `Cannot find KDC for realm` or `Server not found in Kerberos database` | DNS or `krb5.conf`. Check steps 4 and 5, and use the server's FQDN, not a short name or IP.               |
| `Access is denied`                                          | The account can't use that computer or session configuration. Try `authentication: Kerberos` to rule out NTLM limits. |
| swamp reports `exited N without a response`                 | pwsh didn't start: wrong `executable`, or pwsh isn't on the PATH of the process running swamp. The error includes pwsh's stderr. |

## License

MIT
