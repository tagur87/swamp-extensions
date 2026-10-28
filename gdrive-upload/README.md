# @tagur/gdrive-upload

Upload local files into Google Drive (My Drive), under a named folder, from
swamp.

- **Find-or-create folders.** `ensure-folder` is idempotent — it returns the
  existing folder id when one already exists, so repeat runs never duplicate.
- **Single or batch upload.** `upload-file` for one file, `upload-many` for a
  manifest of files in one run (it continues past individual failures and
  reports them).
- **Vault-sourced token.** The Drive OAuth access token comes from a vault and
  is never written into a stored resource.

## Authentication

You need a Google OAuth access token with the Drive scope, supplied via the
`accessToken` global argument from a vault. The easiest source is
[`@atalanta/gcloud-token`](https://github.com/Atalanta/swamp-gcloud-token),
which mints a fresh token per run from the gcloud CLI (nothing stored).

```bash
swamp extension pull @atalanta/gcloud-token

# Give the gcloud login the Drive scope. (ADC alone is not enough — the
# gcloud-token vault calls `gcloud auth print-access-token`, which uses your
# regular gcloud login.)
gcloud auth login --enable-gdrive-access

swamp vault create @atalanta/gcloud-token gdrive-token \
  --config '{"gcloudPath":"/opt/homebrew/bin/gcloud","scopes":"https://www.googleapis.com/auth/drive"}'
```

### The quota-project requirement (important)

With *user* Application Default Credentials, the Drive API returns
**HTTP 403 "requires a quota project"** unless a quota project is attached.
This extension handles it by sending the `x-goog-user-project` header on every
request — you just set `quotaProject` to a GCP project id that has the Drive
API enabled:

```bash
gcloud services enable drive.googleapis.com --project my-gcp-project
```

Without a valid `quotaProject`, uploads fail with a clear 403 explaining this.

## Quick start

```bash
swamp extension pull @tagur/gdrive-upload

swamp behavior create @tagur/gdrive-upload gdrive \
  --global-arg 'accessToken=${{ vault.get("gdrive-token","ACCESS_TOKEN") }}' \
  --global-arg 'quotaProject=my-gcp-project'

# Find or create /Inbox in My Drive.
swamp behavior run gdrive ensure-folder --arg name=Inbox --arg parentId=root

# Upload one file into it (folderId comes from ensure-folder's output).
swamp behavior run gdrive upload-file \
  --arg path=/tmp/report.pdf \
  --arg name='2026-10-26 - Monthly report.pdf' \
  --arg folderId=<folder-id>
```

## Methods

| Method          | Key arguments                             | Purpose                                              |
| --------------- | ----------------------------------------- | ---------------------------------------------------- |
| `ensure-folder` | `name`, `parentId` (default `root`)       | Find or create a folder; idempotent. Records its id. |
| `upload-file`   | `path`, `name`, `folderId`, `mimeType?`   | Multipart-upload one local file into a folder.       |
| `upload-many`   | `folderId`, `files: [{path,name,mimeType?}]` | Upload a batch in one run; reports per-file results. |

`upload-many` takes the shape a producer step can emit directly: a list of
`{ path, name, mimeType? }`. It records a `batch` resource with
`{ total, uploaded, failed, results[] }` and does not abort the whole batch on
a single failure.

## Global arguments

| Argument       | Default | Description                                                        |
| -------------- | ------- | ------------------------------------------------------------------ |
| `accessToken`  | —       | Drive-scoped OAuth token (sensitive). Wire from a vault.           |
| `quotaProject` | —       | GCP project id sent as `x-goog-user-project`. Required (see above).|
| `timeoutMs`    | `60000` | Per-request timeout in milliseconds.                               |

## Data

- **`folder`** — a resolved folder (`name`, `folderId`, `parentId`, `created`).
- **`upload`** — a single uploaded file (`fileId`, `name`, `folderId`, `bytes`,
  `webViewLink`).
- **`batch`** — results of an `upload-many` run.

## Scope note

The Drive scope you grant determines reach. `drive.file` (access only to files
this app creates) is the least-privilege choice and is enough for
create-folder + upload. Use the broader `drive` scope only if you need to touch
pre-existing files.

## License

MIT
