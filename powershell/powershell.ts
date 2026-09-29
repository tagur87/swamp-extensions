/**
 * Remote PowerShell for swamp.
 *
 * `invoke` runs a script block on a remote computer with `Invoke-Command`,
 * optionally inside a named session configuration. The script is a
 * template: every `{{name}}` placeholder is replaced with the matching entry
 * from `variables`, rendered as a single-quoted PowerShell string literal, so
 * a value can hold any text (quotes, `;`, `$(...)`) without being able to
 * change the command around it. The rendered script contains only literals,
 * so it also runs on endpoints with a restricted language mode.
 *
 * The local side runs a PowerShell 7 executable (default `pwsh`). On Linux
 * and macOS, `Invoke-Command -ComputerName` needs a WSMan client (the
 * PSWSMan module) and, for domain auth, Kerberos or NTLM support in the
 * host's GSSAPI. The request, including the credential, travels over stdin,
 * never on the command line.
 *
 * @module
 */
import { z } from "npm:zod@4.6.5";

const EXTENSION_NAME = "@tagur/powershell";

const GlobalArgsSchema = z.object({
  executable: z.string().min(1).default("pwsh").describe(
    "Local PowerShell executable that runs Invoke-Command: pwsh, or " +
      "powershell.exe on Windows. On Linux/macOS pwsh needs a WSMan client " +
      "(PSWSMan module).",
  ),
  username: z.string().optional().describe(
    "User for -Credential, e.g. DOMAIN\\user or user@domain. Omit to use " +
      "the identity the executable runs as.",
  ),
  password: z.string().optional().meta({ sensitive: true }).describe(
    "Password for username. Reference a vault: " +
      '${{ vault.get("<vault>", "<key>") }}',
  ),
  authentication: z.enum([
    "Default",
    "Negotiate",
    "Kerberos",
    "CredSSP",
    "Basic",
  ]).default("Default").describe("Invoke-Command -Authentication mechanism"),
  useSSL: z.boolean().default(false).describe(
    "Connect over HTTPS (WinRM port 5986)",
  ),
  port: z.number().int().min(1).max(65535).optional().describe(
    "WinRM port override",
  ),
  timeoutSeconds: z.number().int().min(1).max(3600).default(300).describe(
    "Kill the local PowerShell process after this many seconds",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const InvokeArgsSchema = z.object({
  computerName: z.string().min(1).describe(
    "Remote computer passed to -ComputerName",
  ),
  configurationName: z.string().min(1).optional().describe(
    "Session configuration passed to -ConfigurationName",
  ),
  script: z.string().min(1).describe(
    "Script block body. {{name}} placeholders are replaced with quoted " +
      "literals from variables; a placeholder already wrapped in single " +
      "quotes ('{{name}}') is handled the same way.",
  ),
  variables: z.record(z.string(), z.string()).default({}).describe(
    "Values for the {{name}} placeholders in script",
  ),
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).optional().describe(
    "Data instance name for the result. Defaults to a slug of " +
      "computerName and configurationName.",
  ),
});

type InvokeArgs = z.infer<typeof InvokeArgsSchema>;

const ResultSchema = z.object({
  computerName: z.string(),
  configurationName: z.string().nullable(),
  script: z.string(),
  variables: z.record(z.string(), z.string()),
  username: z.string().nullable(),
  text: z.string(),
  objects: z.unknown(),
  startedAt: z.string(),
  durationMs: z.number(),
  collectedBy: z.string(),
});

/** Placeholder names: letters, digits, `_`, `.` and `-`. */
const PLACEHOLDER =
  /'\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}'|\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g;

/**
 * Quote a value as a PowerShell single-quoted string literal.
 *
 * PowerShell treats the typographic quotes U+2018–U+201B as single quotes
 * too, so each of them is doubled along with `'`.
 */
export function quotePowerShell(value: string): string {
  return `'${value.replace(/['‘’‚‛]/g, "$&$&")}'`;
}

/**
 * Replace every `{{name}}` in `template` with the quoted value of
 * `variables[name]`. Throws when a placeholder has no value.
 */
export function renderScript(
  template: string,
  variables: Record<string, string>,
): string {
  const missing = new Set<string>();
  const rendered = template.replace(
    PLACEHOLDER,
    (_match: string, quoted?: string, bare?: string) => {
      const key = (quoted ?? bare) as string;
      if (!Object.hasOwn(variables, key)) {
        missing.add(key);
        return "";
      }
      return quotePowerShell(variables[key]);
    },
  );
  if (missing.size > 0) {
    throw new Error(
      `No value for script placeholder(s): ${[...missing].join(", ")}`,
    );
  }
  return rendered;
}

/** Slug a string into a valid data instance name. */
export function instanceName(computerName: string, config?: string): string {
  const host = computerName.split(".")[0];
  const slug = [host, config ?? "default"].join("-").toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return (slug || "invoke").slice(0, 63).replace(/-$/, "");
}

/**
 * Runs locally inside the PowerShell executable. Reads a base64 UTF-8 JSON
 * request from stdin and writes a base64 UTF-8 JSON response to stdout, so
 * neither direction depends on the console code page.
 */
const WRAPPER = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Send($obj) {
  $json = ConvertTo-Json -InputObject $obj -Depth 3 -Compress
  [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))
}
try {
  $raw = [Console]::In.ReadToEnd().Trim()
  $req = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($raw)) | ConvertFrom-Json
  $p = @{
    ComputerName = $req.computerName
    ScriptBlock = [scriptblock]::Create($req.script)
    ErrorAction = 'Stop'
  }
  if ($req.configurationName) { $p.ConfigurationName = $req.configurationName }
  if ($req.authentication -ne 'Default') { $p.Authentication = $req.authentication }
  if ($req.useSSL) { $p.UseSSL = $true }
  if ($req.port) { $p.Port = [int]$req.port }
  if ($req.username) {
    $sec = ConvertTo-SecureString -String $req.password -AsPlainText -Force
    $p.Credential = New-Object System.Management.Automation.PSCredential($req.username, $sec)
  }
  $out = @(Invoke-Command @p)
  # The command has already run; a formatting failure must not report it as failed.
  $text = try { ($out | Out-String).TrimEnd() } catch { '' }
  $objects = $null
  $objectsError = $null
  try {
    $objects = if ($out.Count -gt 0) { ConvertTo-Json -InputObject $out -Depth 4 -Compress } else { '[]' }
  } catch { $objectsError = $_.Exception.Message }
  Send @{ ok = $true; text = $text; objects = $objects; objectsError = $objectsError }
  exit 0
} catch {
  Send @{ ok = $false; error = $_.Exception.Message; errorId = "$($_.FullyQualifiedErrorId)" }
  exit 1
}
`;

/** Encode a script for powershell -EncodedCommand (base64 of UTF-16LE). */
function encodeCommand(script: string): string {
  const bytes = new Uint8Array(script.length * 2);
  for (let i = 0; i < script.length; i++) {
    const c = script.charCodeAt(i);
    bytes[i * 2] = c & 0xff;
    bytes[i * 2 + 1] = c >> 8;
  }
  return bytesToBase64(bytes);
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function base64ToText(b64: string): string {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

interface WrapperResponse {
  ok: boolean;
  text?: string;
  objects?: string | null;
  objectsError?: string | null;
  error?: string;
  errorId?: string;
}

/** Decode the last base64 token on stdout; PowerShell may print other noise. */
function parseResponse(stdout: string): WrapperResponse | null {
  const token = stdout.trim().split(/\s+/).pop();
  if (!token) return null;
  try {
    return JSON.parse(base64ToText(token)) as WrapperResponse;
  } catch {
    return null;
  }
}

/** Model definition for remote PowerShell over WinRM. */
export const model = {
  type: "@tagur/powershell",
  version: "2026.09.29.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.09.29.1",
      description:
        "Default executable is now pwsh; globalArguments unchanged otherwise",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    result: {
      description: "Output of an Invoke-Command run",
      schema: ResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
  },
  methods: {
    invoke: {
      description:
        "Run a templated script block on a remote computer with Invoke-Command",
      arguments: InvokeArgsSchema,
      execute: async (
        args: InvokeArgs,
        context: {
          globalArgs: GlobalArgs;
          signal?: AbortSignal;
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
            warning: (msg: string, props?: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ): Promise<{ dataHandles: { name: string }[] }> => {
        const g = context.globalArgs;
        if (Boolean(g.username) !== Boolean(g.password)) {
          throw new Error("Set both username and password, or neither");
        }
        const variables = args.variables ?? {};
        const script = renderScript(args.script, variables);

        const request = {
          computerName: args.computerName,
          configurationName: args.configurationName ?? null,
          script,
          authentication: g.authentication ?? "Default",
          useSSL: g.useSSL ?? false,
          port: g.port ?? null,
          username: g.username ?? null,
          password: g.password ?? null,
        };

        context.logger.info("Invoke-Command on {computer} ({config})", {
          computer: args.computerName,
          config: args.configurationName ?? "default endpoint",
        });

        const timeoutMs = (g.timeoutSeconds ?? 300) * 1000;
        const signals = [AbortSignal.timeout(timeoutMs)];
        if (context.signal) signals.push(context.signal);
        const signal = AbortSignal.any(signals);

        const executable = g.executable ?? "pwsh";
        const startedAt = new Date();
        let child: Deno.ChildProcess;
        try {
          child = new Deno.Command(executable, {
            args: [
              "-NoProfile",
              "-NonInteractive",
              "-EncodedCommand",
              encodeCommand(WRAPPER),
            ],
            stdin: "piped",
            stdout: "piped",
            stderr: "piped",
            signal,
          }).spawn();
        } catch (err) {
          throw new Error(
            `Could not start ${executable}: ${(err as Error).message}. ` +
              "Check that PowerShell is installed and on PATH, or set executable.",
          );
        }

        // If PowerShell exits before reading stdin the write fails with a
        // broken pipe; its exit code and stderr below explain why.
        const writer = child.stdin.getWriter();
        try {
          await writer.write(
            new TextEncoder().encode(
              bytesToBase64(new TextEncoder().encode(JSON.stringify(request))),
            ),
          );
          await writer.close();
        } catch {
          // reported through the missing response below
        }

        const out = await child.output();
        const durationMs = Date.now() - startedAt.getTime();
        const stdout = new TextDecoder().decode(out.stdout);
        const stderr = new TextDecoder().decode(out.stderr).trim();

        if (signal.aborted) {
          throw new Error(
            context.signal?.aborted
              ? "Invoke-Command cancelled"
              : `Invoke-Command timed out after ${g.timeoutSeconds ?? 300}s`,
          );
        }
        const response = parseResponse(stdout);
        if (!response) {
          throw new Error(
            `${executable} exited ${out.code} without a response` +
              (stderr ? `: ${stderr.slice(0, 2000)}` : ""),
          );
        }
        if (!response.ok) {
          throw new Error(
            `Invoke-Command on ${args.computerName} failed: ${response.error}` +
              (response.errorId ? ` [${response.errorId}]` : ""),
          );
        }

        let objects: unknown = null;
        if (response.objectsError) {
          context.logger.warning(
            "Command succeeded but its output could not be converted to JSON: {error}",
            { error: response.objectsError },
          );
        } else {
          try {
            objects = JSON.parse(response.objects ?? "null");
          } catch {
            objects = response.objects ?? null;
          }
        }

        const handle = await context.writeResource(
          "result",
          args.name ?? instanceName(args.computerName, args.configurationName),
          {
            computerName: args.computerName,
            configurationName: args.configurationName ?? null,
            script,
            variables,
            username: g.username ?? null,
            text: response.text ?? "",
            objects,
            startedAt: startedAt.toISOString(),
            durationMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        context.logger.info(
          "Invoke-Command on {computer} succeeded in {durationMs}ms",
          { computer: args.computerName, durationMs },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
