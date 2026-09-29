/**
 * Unit tests for the @tagur/powershell model.
 *
 * `invoke` tests swap the PowerShell executable for a small shell script that
 * records its stdin and argv and prints a canned wrapper response, so the
 * whole request/response path runs without Windows.
 *
 * @module
 */
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260706.24";
import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { instanceName, model, quotePowerShell, renderScript } from "./powershell.ts";

type InvokeCtx = Parameters<typeof model.methods.invoke.execute>[1];
type InvokeArgs = Parameters<typeof model.methods.invoke.execute>[0];

function b64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

function unb64(text: string): string {
  return new TextDecoder().decode(
    Uint8Array.from(atob(text.trim()), (c) => c.charCodeAt(0)),
  );
}

/** Write a fake executable that saves stdin/argv and prints `response`. */
async function fakeExecutable(
  dir: string,
  response: Record<string, unknown>,
  exitCode = 0,
): Promise<string> {
  const path = `${dir}/fake-pwsh.sh`;
  await Deno.writeTextFile(
    path,
    `#!/bin/sh
cat > "${dir}/stdin.txt"
printf '%s\\n' "$@" > "${dir}/argv.txt"
echo "WARNING: some console noise"
printf '%s' '${b64(JSON.stringify(response))}'
exit ${exitCode}
`,
  );
  await Deno.chmod(path, 0o755);
  return path;
}

function testContext(globalArgs: Record<string, unknown>) {
  const harness = createModelTestContext({
    globalArgs: {
      authentication: "Default",
      useSSL: false,
      timeoutSeconds: 30,
      ...globalArgs,
    },
  });
  // The runtime logger has `warning`; the harness only declares `warn`.
  const logger = harness.context.logger;
  const context = {
    ...harness.context,
    logger: Object.assign({}, logger, {
      warning: (msg: string, props?: Record<string, unknown>) =>
        logger.warn(msg, props),
    }),
  } as unknown as InvokeCtx;
  return { ...harness, context };
}

const SAMPLE_SCRIPT =
  "Restart-Service -Name '{{service}}' -PassThru; Write-Output {{note}}";

Deno.test("quotePowerShell doubles straight and typographic single quotes", () => {
  assertEquals(quotePowerShell("plain"), "'plain'");
  assertEquals(quotePowerShell("it's"), "'it''s'");
  assertEquals(quotePowerShell("it\u2019s"), "'it\u2019\u2019s'");
  assertEquals(quotePowerShell(""), "''");
});

Deno.test("renderScript quotes bare and pre-quoted placeholders", () => {
  const out = renderScript(SAMPLE_SCRIPT, {
    service: "Spooler",
    note: "ticket 123",
  });
  assertEquals(
    out,
    "Restart-Service -Name 'Spooler' -PassThru; Write-Output 'ticket 123'",
  );
});

Deno.test("renderScript neutralizes injection attempts", () => {
  const out = renderScript("Write-Output {{x}}", {
    x: "'; Remove-Item C:\\ -Recurse; '$(whoami)",
  });
  assertEquals(
    out,
    "Write-Output '''; Remove-Item C:\\ -Recurse; ''$(whoami)'",
  );
});

Deno.test("renderScript allows whitespace inside braces and repeats", () => {
  assertEquals(renderScript("{{ a }} {{a}}", { a: "v" }), "'v' 'v'");
});

Deno.test("renderScript lists every missing placeholder", () => {
  const err = assertThrows(() => renderScript("{{a}} {{b}} {{a}}", {}));
  assertEquals(
    (err as Error).message,
    "No value for script placeholder(s): a, b",
  );
});

Deno.test("renderScript leaves text without placeholders unchanged", () => {
  assertEquals(renderScript("Get-Date", {}), "Get-Date");
});

Deno.test("instanceName slugs host and configuration", () => {
  assertEquals(
    instanceName("server01.example.com", "Ops.Endpoint"),
    "server01-ops-endpoint",
  );
  assertEquals(instanceName("HOST01"), "host01-default");
  assert(instanceName("a", "x".repeat(100)).length <= 63);
});

Deno.test("invoke sends the request over stdin and stores the result", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const exe = await fakeExecutable(dir, {
      ok: true,
      text: "added",
      objects: '[{"Status":"Added"}]',
    });
    const { context, getWrittenResources } = testContext({
      executable: exe,
      username: "EXAMPLE\\svc",
      password: "s3cret'pw",
    });
    const args: InvokeArgs = {
      computerName: "server01.example.com",
      configurationName: "Ops.Endpoint",
      script: SAMPLE_SCRIPT,
      variables: { service: "Spooler", note: "RM 1" },
    };
    await model.methods.invoke.execute(args, context);

    const req = JSON.parse(unb64(await Deno.readTextFile(`${dir}/stdin.txt`)));
    assertEquals(req.computerName, "server01.example.com");
    assertEquals(req.configurationName, "Ops.Endpoint");
    assertEquals(req.username, "EXAMPLE\\svc");
    assertEquals(req.password, "s3cret'pw");
    assertEquals(
      req.script,
      "Restart-Service -Name 'Spooler' -PassThru; Write-Output 'RM 1'",
    );

    const argv = await Deno.readTextFile(`${dir}/argv.txt`);
    assert(argv.includes("-EncodedCommand"));
    assert(!argv.includes("s3cret"), "password must not be on the command line");

    const written = getWrittenResources();
    assertEquals(written.length, 1);
    assertEquals(written[0].name, "server01-ops-endpoint");
    const data = written[0].data as Record<string, unknown>;
    assertEquals(data.text, "added");
    assertEquals(data.objects, [{ Status: "Added" }]);
    assertEquals(data.username, "EXAMPLE\\svc");
    assert(!("password" in data));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("invoke throws the remote error and writes nothing", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const exe = await fakeExecutable(
      dir,
      { ok: false, error: "Access is denied.", errorId: "AccessDenied" },
      1,
    );
    const { context, getWrittenResources } = testContext({ executable: exe });
    await assertRejects(
      () =>
        model.methods.invoke.execute({
          computerName: "host",
          script: "Get-Date",
          variables: {},
        }, context),
      Error,
      "Access is denied. [AccessDenied]",
    );
    assertEquals(getWrittenResources().length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("invoke rejects a username without a password", async () => {
  const { context } = testContext({ executable: "/bin/false", username: "u" });
  await assertRejects(
    () =>
      model.methods.invoke.execute({
        computerName: "host",
        script: "Get-Date",
        variables: {},
      }, context),
    Error,
    "Set both username and password",
  );
});

Deno.test("invoke reports a missing response with stderr", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const exe = `${dir}/broken.sh`;
    await Deno.writeTextFile(exe, "#!/bin/sh\ncat >/dev/null\necho boom >&2\nexit 3\n");
    await Deno.chmod(exe, 0o755);
    const { context } = testContext({ executable: exe });
    await assertRejects(
      () =>
        model.methods.invoke.execute({
          computerName: "host",
          script: "Get-Date",
          variables: {},
        }, context),
      Error,
      "exited 3 without a response: boom",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("invoke stores text when objects cannot be serialized", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const exe = await fakeExecutable(dir, {
      ok: true,
      text: "done",
      objects: null,
      objectsError: "depth overflow",
    });
    const { context, getWrittenResources, getLogsByLevel } = testContext({
      executable: exe,
    });
    await model.methods.invoke.execute({
      computerName: "host",
      script: "Get-Date",
      variables: {},
    }, context);
    const data = getWrittenResources()[0].data as Record<string, unknown>;
    assertEquals(data.text, "done");
    assertEquals(data.objects, null);
    assertEquals(getLogsByLevel("warning").length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("invoke explains a missing executable", async () => {
  const { context } = testContext({ executable: "/nonexistent/pwsh" });
  await assertRejects(
    () =>
      model.methods.invoke.execute({
        computerName: "host",
        script: "Get-Date",
        variables: {},
      }, context),
    Error,
    "Could not start /nonexistent/pwsh",
  );
});
