/**
 * Upload local files into Google Drive (My Drive), under a named folder.
 *
 * Auth is a Google OAuth access token minted per-run by the
 * `@atalanta/gcloud-token` vault (which shells out to the gcloud CLI, so the
 * token is never stale and nothing is stored). The token is wired into the
 * `accessToken` global argument from that vault; it is treated as sensitive and
 * never written into a stored resource.
 *
 * One non-obvious requirement: these are *user* Application Default
 * Credentials, and the Drive API rejects user ADC that has no quota project
 * (HTTP 403 "requires a quota project"). The fix proven against this account is
 * to send the `x-goog-user-project: <projectId>` header on every Drive call —
 * so `quotaProject` is a required global argument and the header goes on every
 * request.
 *
 * Methods:
 *   - ensure-folder : find a folder by name under a parent (default My Drive
 *                     root), creating it if absent. Idempotent. Records the
 *                     folder id.
 *   - upload-file   : multipart-upload one local file into a folder under a
 *                     chosen name. Records the created file's id and name.
 *
 * @module
 */
import { z } from "npm:zod@4";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

// ---------------------------------------------------------------------------
// Global arguments
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  accessToken: z.string().meta({ sensitive: true }).describe(
    "Google OAuth access token with Drive scope. Wire from the " +
      "@atalanta/gcloud-token vault; never inline.",
  ),
  quotaProject: z.string().min(1).describe(
    "GCP project id sent as x-goog-user-project. Required for user ADC: the " +
      "Drive API rejects user credentials with no quota project.",
  ),
  timeoutMs: z.number().int().positive().default(60000).describe(
    "Per-request timeout in milliseconds (uploads can be large).",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// Resource schemas
// ---------------------------------------------------------------------------

const FolderSchema = z.object({
  name: z.string(),
  folderId: z.string(),
  parentId: z.string().describe("Parent folder id, or 'root'."),
  created: z.boolean().describe("True if this run created it, false if found."),
  resolvedAt: z.string(),
});

const UploadSchema = z.object({
  fileId: z.string(),
  name: z.string(),
  folderId: z.string(),
  bytes: z.number().int().nonnegative(),
  mimeType: z.string().nullable(),
  webViewLink: z.string().nullable(),
  uploadedAt: z.string(),
});

const BatchResultSchema = z.object({
  name: z.string(),
  fileId: z.string().nullable(),
  bytes: z.number().int().nonnegative(),
  mimeType: z.string().nullable(),
  webViewLink: z.string().nullable(),
  ok: z.boolean(),
  error: z.string().nullable(),
});

const BatchSchema = z.object({
  folderId: z.string(),
  total: z.number().int().nonnegative(),
  uploaded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  results: z.array(BatchResultSchema),
  uploadedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Method context
// ---------------------------------------------------------------------------

interface MethodContext {
  globalArgs: GlobalArgs;
  signal: AbortSignal;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

// ---------------------------------------------------------------------------
// Drive helpers
// ---------------------------------------------------------------------------

/** Headers carrying the token and the required quota project. */
function driveHeaders(g: GlobalArgs): Record<string, string> {
  return {
    "Authorization": `Bearer ${g.accessToken}`,
    "x-goog-user-project": g.quotaProject,
  };
}

/** Surface a Drive API error body as a readable message. */
async function driveError(resp: Response, what: string): Promise<Error> {
  const text = await resp.text().catch(() => "");
  let detail = text.slice(0, 300);
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const err = (j["error"] ?? {}) as Record<string, unknown>;
    if (err["message"]) detail = String(err["message"]);
  } catch {
    // keep raw
  }
  if (resp.status === 401) {
    return new Error(
      `${what}: HTTP 401 — the Drive access token is missing or expired. ` +
        "Confirm the gcloud-token vault can mint a token. " + detail,
    );
  }
  if (resp.status === 403 && /quota project/i.test(detail)) {
    return new Error(
      `${what}: HTTP 403 quota-project error — set quotaProject to a GCP ` +
        "project with the Drive API enabled. " + detail,
    );
  }
  return new Error(`${what}: HTTP ${resp.status}. ${detail}`);
}

/** Drive query strings escape single quotes by doubling; values can't hold NUL. */
function escapeQueryValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** Resolve a leading ~ against HOME. */
function resolveHome(p: string): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";
  return p.startsWith("~/") && home ? `${home}${p.slice(1)}` : p;
}

interface UploadResult {
  fileId: string;
  name: string;
  mimeType: string;
  bytes: number;
  webViewLink: string | null;
}

/**
 * Multipart-upload one local file into a Drive folder. Shared by upload-file
 * and upload-many.
 */
async function uploadOne(
  g: GlobalArgs,
  localPath: string,
  driveName: string,
  folderId: string,
  mimeType: string | undefined,
  signal: AbortSignal,
): Promise<UploadResult> {
  const path = resolveHome(localPath);
  const bytes = await Deno.readFile(path);
  const mime = mimeType ?? "application/octet-stream";

  // Multipart/related: a JSON metadata part, then the raw file bytes.
  const boundary = `swamp-${crypto.randomUUID()}`;
  const enc = new TextEncoder();
  const metadata = JSON.stringify({ name: driveName, parents: [folderId] });
  const preamble = enc.encode(
    `--${boundary}\r\n` +
      "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
      `${metadata}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${mime}\r\n\r\n`,
  );
  const epilogue = enc.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(
    preamble.byteLength + bytes.byteLength + epilogue.byteLength,
  );
  body.set(preamble, 0);
  body.set(bytes, preamble.byteLength);
  body.set(epilogue, preamble.byteLength + bytes.byteLength);

  const url = `${DRIVE_UPLOAD}?` +
    new URLSearchParams({
      uploadType: "multipart",
      fields: "id,name,mimeType,webViewLink",
    }).toString();

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      ...driveHeaders(g),
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
    signal: AbortSignal.any([signal, AbortSignal.timeout(g.timeoutMs)]),
  });
  if (!resp.ok) throw await driveError(resp, `Upload of ${driveName}`);
  const made = await resp.json() as {
    id: string;
    name: string;
    mimeType?: string;
    webViewLink?: string;
  };
  return {
    fileId: made.id,
    name: made.name,
    mimeType: made.mimeType ?? mime,
    bytes: bytes.byteLength,
    webViewLink: made.webViewLink ?? null,
  };
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** Upload local files into Google Drive (My Drive) under a named folder. */
export const model = {
  type: "@tagur/gdrive-upload",
  version: "2026.10.26.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    "folder": {
      description: "A resolved (found or created) Drive folder and its id.",
      schema: FolderSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "upload": {
      description: "A file uploaded to Drive: its id, name, and parent folder.",
      schema: UploadSchema,
      lifetime: "infinite" as const,
      garbageCollection: 200,
    },
    "batch": {
      description:
        "Per-file results of an upload-many batch (ok/failed, ids, links).",
      schema: BatchSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
  },

  methods: {
    "ensure-folder": {
      description:
        "Find a non-trashed folder by exact name under a parent (default My " +
        "Drive root), creating it if absent. Idempotent — returns the existing " +
        "folder id when one already exists. Records the folder id for " +
        "upload-file.",
      arguments: z.object({
        name: z.string().min(1).describe("Folder name, e.g. Inbox."),
        parentId: z.string().default("root").describe(
          "Parent folder id. 'root' is My Drive's top level.",
        ),
      }),
      execute: async (
        args: { name: string; parentId: string },
        context: MethodContext,
      ) => {
        const g = context.globalArgs;
        const q = [
          `name='${escapeQueryValue(args.name)}'`,
          "mimeType='application/vnd.google-apps.folder'",
          `'${escapeQueryValue(args.parentId)}' in parents`,
          "trashed=false",
        ].join(" and ");
        const searchUrl = `${DRIVE_API}/files?` +
          new URLSearchParams({
            q,
            fields: "files(id,name)",
            spaces: "drive",
          }).toString();

        const signal = AbortSignal.any([
          context.signal,
          AbortSignal.timeout(g.timeoutMs),
        ]);

        const found = await fetch(searchUrl, {
          headers: { ...driveHeaders(g), Accept: "application/json" },
          signal,
        });
        if (!found.ok) throw await driveError(found, "Folder search");
        const list = await found.json() as {
          files?: { id: string; name: string }[];
        };
        const existing = (list.files ?? [])[0];

        let folderId: string;
        let created: boolean;
        if (existing) {
          folderId = existing.id;
          created = false;
          context.logger.info("Found folder {name} ({id})", {
            name: args.name,
            id: folderId,
          });
        } else {
          const createResp = await fetch(
            `${DRIVE_API}/files?` +
              new URLSearchParams({ fields: "id,name" }).toString(),
            {
              method: "POST",
              headers: {
                ...driveHeaders(g),
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                name: args.name,
                mimeType: "application/vnd.google-apps.folder",
                parents: [args.parentId],
              }),
              signal,
            },
          );
          if (!createResp.ok) {
            throw await driveError(createResp, "Folder create");
          }
          const made = await createResp.json() as { id: string };
          folderId = made.id;
          created = true;
          context.logger.info("Created folder {name} ({id})", {
            name: args.name,
            id: folderId,
          });
        }

        const handle = await context.writeResource(
          "folder",
          `folder-${args.name}`,
          {
            name: args.name,
            folderId,
            parentId: args.parentId,
            created,
            resolvedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    "upload-file": {
      description:
        "Multipart-upload one local file into a Drive folder under a chosen " +
        "name. Records the created file's id and webViewLink.",
      arguments: z.object({
        path: z.string().min(1).describe("Absolute path of the local file."),
        name: z.string().min(1).describe(
          "Filename to create in Drive (e.g. '2026-10-24 - Subject - orig.pdf').",
        ),
        folderId: z.string().min(1).describe(
          "Destination folder id from ensure-folder.",
        ),
        mimeType: z.string().optional().describe(
          "MIME type; defaults to application/octet-stream.",
        ),
      }),
      execute: async (
        args: {
          path: string;
          name: string;
          folderId: string;
          mimeType?: string;
        },
        context: MethodContext,
      ) => {
        const g = context.globalArgs;
        const made = await uploadOne(
          g,
          args.path,
          args.name,
          args.folderId,
          args.mimeType,
          context.signal,
        );

        context.logger.info("Uploaded {name} ({bytes}B) -> {id}", {
          name: made.name,
          bytes: made.bytes,
          id: made.fileId,
        });

        const handle = await context.writeResource(
          "upload",
          `upload-${made.fileId}`,
          {
            fileId: made.fileId,
            name: made.name,
            folderId: args.folderId,
            bytes: made.bytes,
            mimeType: made.mimeType,
            webViewLink: made.webViewLink,
            uploadedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    "upload-many": {
      description:
        "Upload a batch of local files into one Drive folder in a single run " +
        "(fan-out). Takes a manifest of {path, name, mimeType?} — the shape " +
        "harvest-attachments emits (localPath→path, driveName→name). Records " +
        "a per-file result batch; continues past individual failures and " +
        "reports them.",
      arguments: z.object({
        folderId: z.string().min(1).describe("Destination folder id."),
        files: z.array(
          z.object({
            path: z.string().min(1),
            name: z.string().min(1),
            mimeType: z.string().optional(),
          }),
        ).describe(
          "Files to upload: path (local), name (Drive), optional mimeType.",
        ),
      }),
      execute: async (
        args: {
          folderId: string;
          files: Array<{ path: string; name: string; mimeType?: string }>;
        },
        context: MethodContext,
      ) => {
        const g = context.globalArgs;
        const results: Array<Record<string, unknown>> = [];
        let ok = 0;
        let failed = 0;

        for (const f of args.files) {
          try {
            const made = await uploadOne(
              g,
              f.path,
              f.name,
              args.folderId,
              f.mimeType,
              context.signal,
            );
            results.push({
              name: made.name,
              fileId: made.fileId,
              bytes: made.bytes,
              mimeType: made.mimeType,
              webViewLink: made.webViewLink,
              ok: true,
              error: null,
            });
            ok++;
            context.logger.info("Uploaded {name} -> {id}", {
              name: made.name,
              id: made.fileId,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            results.push({
              name: f.name,
              fileId: null,
              bytes: 0,
              mimeType: f.mimeType ?? null,
              webViewLink: null,
              ok: false,
              error: msg,
            });
            failed++;
            context.logger.warning("Upload failed for {name}: {error}", {
              name: f.name,
              error: msg,
            });
          }
        }

        context.logger.info("Batch upload: {ok} ok, {failed} failed", {
          ok,
          failed,
        });

        const handle = await context.writeResource(
          "batch",
          `batch-${args.folderId}`,
          {
            folderId: args.folderId,
            total: args.files.length,
            uploaded: ok,
            failed,
            results,
            uploadedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
