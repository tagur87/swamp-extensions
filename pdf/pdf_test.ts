/**
 * Unit tests for the @tagur/pdf model.
 *
 * Exercises both methods (extract, extract_batch) against real temp-directory
 * PDF fixtures generated with pdf-lib. Covers success paths, error paths
 * (missing file, not a file, empty directory), duplicate filename handling,
 * pattern filtering, and schema conformance of written resources.
 */
import {
  assertEquals,
  assertExists,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing";
import { PDFDocument, StandardFonts } from "npm:pdf-lib@1.17.1";
import { model } from "./pdf.ts";

type MethodCtx = Parameters<typeof model.methods.extract.execute>[1];

function ctx() {
  const c = createModelTestContext({ globalArgs: {} });
  return {
    context: c.context as unknown as MethodCtx,
    getWrittenResources: c.getWrittenResources,
    getLogs: c.getLogs,
    getLogsByLevel: c.getLogsByLevel,
  };
}

/** Create a minimal PDF with the given text content and return the bytes. */
async function createTestPdf(text: string, title?: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  if (title) doc.setTitle(title);
  doc.setAuthor("Test Author");
  doc.setCreationDate(new Date("2026-01-15T10:00:00Z"));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText(text, { x: 50, y: 700, size: 12, font });
  return await doc.save();
}

/** Create a temp directory with N PDF files and return the dir path + file paths. */
async function createTempPdfs(
  files: Array<{ name: string; text: string; title?: string }>,
): Promise<{ dir: string; paths: string[] }> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-pdf-test-" });
  const paths: string[] = [];
  for (const f of files) {
    const bytes = await createTestPdf(f.text, f.title);
    const path = `${dir}/${f.name}`;
    await Deno.writeFile(path, bytes);
    paths.push(path);
  }
  return { dir, paths };
}

// ── extract: success ───────────────────────────────────────────────────────

Deno.test("extract writes a document resource with markdown and metadata", async () => {
  const { context, getWrittenResources } = ctx();
  const { dir, paths } = await createTempPdfs([
    { name: "report.pdf", text: "Hello World", title: "Test Report" },
  ]);

  try {
    const result = await model.methods.extract.execute(
      { filePath: paths[0] },
      context,
    );

    assertEquals(result.dataHandles.length, 1);
    const written = getWrittenResources();
    assertEquals(written.length, 1);
    assertEquals(written[0].specName, "document");
    assertEquals(written[0].name, "report");

    const data = written[0].data as Record<string, unknown>;
    assertEquals(data.fileName, "report.pdf");
    assertStringIncludes(data.filePath as string, "report.pdf");
    assertStringIncludes(data.markdown as string, "Hello World");
    assertExists(data.extractedAt);

    const meta = data.metadata as Record<string, unknown>;
    assertEquals(meta.title, "Test Report");
    assertEquals(meta.author, "Test Author");
    assertEquals(meta.pageCount, 1);
    assertExists(meta.creationDate);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── extract: error paths ───────────────────────────────────────────────────

Deno.test("extract throws on non-existent file", async () => {
  const { context } = ctx();
  await assertRejects(
    () =>
      model.methods.extract.execute(
        { filePath: "/tmp/does-not-exist-swamp-pdf-test.pdf" },
        context,
      ),
    Error,
  );
});

Deno.test("extract throws when path is a directory", async () => {
  const { context } = ctx();
  const dir = await Deno.makeTempDir({ prefix: "swamp-pdf-test-" });
  try {
    await assertRejects(
      () => model.methods.extract.execute({ filePath: dir }, context),
      Error,
      "Not a file",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── extract_batch with filePaths ───────────────────────────────────────────

Deno.test("extract_batch processes an explicit file list", async () => {
  const { context, getWrittenResources } = ctx();
  const { dir, paths } = await createTempPdfs([
    { name: "a.pdf", text: "Document A" },
    { name: "b.pdf", text: "Document B" },
  ]);

  try {
    const result = await model.methods.extract_batch.execute(
      { filePaths: paths, recursive: false },
      context,
    );

    assertEquals(result.dataHandles.length, 2);
    const written = getWrittenResources();
    assertEquals(written.length, 2);
    const names = written.map((w) => w.name).sort();
    assertEquals(names, ["a", "b"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── extract_batch with dirPath ─────────────────────────────────────────────

Deno.test("extract_batch scans a directory for PDFs", async () => {
  const { context, getWrittenResources } = ctx();
  const { dir } = await createTempPdfs([
    { name: "first.pdf", text: "First document" },
    { name: "second.pdf", text: "Second document" },
    { name: "notes.txt", text: "Not a PDF" },
  ]);
  // Write the non-PDF file manually (createTempPdfs only creates PDFs).
  await Deno.writeTextFile(`${dir}/notes.txt`, "Not a PDF");

  try {
    const result = await model.methods.extract_batch.execute(
      { dirPath: dir, recursive: false },
      context,
    );

    assertEquals(result.dataHandles.length, 2);
    const written = getWrittenResources();
    assertEquals(written.length, 2);
    const names = written.map((w) => w.name).sort();
    assertEquals(names, ["first", "second"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── extract_batch: recursive ───────────────────────────────────────────────

Deno.test("extract_batch recurses into subdirectories when enabled", async () => {
  const { context, getWrittenResources } = ctx();
  const dir = await Deno.makeTempDir({ prefix: "swamp-pdf-test-" });
  const subdir = `${dir}/sub`;
  await Deno.mkdir(subdir);

  const topPdf = await createTestPdf("Top level");
  const subPdf = await createTestPdf("Sub level");
  await Deno.writeFile(`${dir}/top.pdf`, topPdf);
  await Deno.writeFile(`${subdir}/nested.pdf`, subPdf);

  try {
    const result = await model.methods.extract_batch.execute(
      { dirPath: dir, recursive: true },
      context,
    );
    assertEquals(result.dataHandles.length, 2);

    const written = getWrittenResources();
    const names = written.map((w) => w.name).sort();
    assertEquals(names, ["nested", "top"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("extract_batch without recursive skips subdirectories", async () => {
  const { context, getWrittenResources } = ctx();
  const dir = await Deno.makeTempDir({ prefix: "swamp-pdf-test-" });
  const subdir = `${dir}/sub`;
  await Deno.mkdir(subdir);

  const topPdf = await createTestPdf("Top level");
  const subPdf = await createTestPdf("Sub level");
  await Deno.writeFile(`${dir}/top.pdf`, topPdf);
  await Deno.writeFile(`${subdir}/nested.pdf`, subPdf);

  try {
    const result = await model.methods.extract_batch.execute(
      { dirPath: dir, recursive: false },
      context,
    );
    assertEquals(result.dataHandles.length, 1);
    assertEquals(getWrittenResources()[0].name, "top");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── extract_batch: pattern filtering ───────────────────────────────────────

Deno.test("extract_batch filters by pattern", async () => {
  const { context, getWrittenResources } = ctx();
  const { dir } = await createTempPdfs([
    { name: "report-2026-01.pdf", text: "January" },
    { name: "report-2026-02.pdf", text: "February" },
    { name: "invoice-001.pdf", text: "Invoice" },
  ]);

  try {
    const result = await model.methods.extract_batch.execute(
      { dirPath: dir, recursive: false, pattern: "^report-" },
      context,
    );

    assertEquals(result.dataHandles.length, 2);
    const names = getWrittenResources().map((w) => w.name).sort();
    assertEquals(names, ["report-2026-01", "report-2026-02"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── extract_batch: duplicate filenames ─────────────────────────────────────

Deno.test("extract_batch deduplicates instance names from duplicate filenames", async () => {
  const { context, getWrittenResources } = ctx();
  const dir = await Deno.makeTempDir({ prefix: "swamp-pdf-test-" });
  const sub1 = `${dir}/a`;
  const sub2 = `${dir}/b`;
  await Deno.mkdir(sub1);
  await Deno.mkdir(sub2);

  const pdf1 = await createTestPdf("Version A");
  const pdf2 = await createTestPdf("Version B");
  await Deno.writeFile(`${sub1}/doc.pdf`, pdf1);
  await Deno.writeFile(`${sub2}/doc.pdf`, pdf2);

  try {
    const result = await model.methods.extract_batch.execute(
      { dirPath: dir, recursive: true },
      context,
    );
    assertEquals(result.dataHandles.length, 2);

    const names = getWrittenResources().map((w) => w.name).sort();
    assertEquals(names, ["doc", "doc-2"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── extract_batch: combined dirPath + filePaths ────────────────────────────

Deno.test("extract_batch combines dirPath and filePaths with dedup", async () => {
  const { context, getWrittenResources } = ctx();
  const { dir, paths } = await createTempPdfs([
    { name: "shared.pdf", text: "Shared content" },
    { name: "extra.pdf", text: "Extra content" },
  ]);

  try {
    const result = await model.methods.extract_batch.execute(
      { dirPath: dir, filePaths: [paths[0]], recursive: false },
      context,
    );
    // shared.pdf appears in both dirPath scan and filePaths — should be deduped.
    assertEquals(result.dataHandles.length, 2);
    assertEquals(getWrittenResources().length, 2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── extract_batch: error paths ─────────────────────────────────────────────

Deno.test("extract_batch throws when neither dirPath nor filePaths is provided", async () => {
  const { context } = ctx();
  await assertRejects(
    () =>
      model.methods.extract_batch.execute(
        { recursive: false },
        context,
      ),
    Error,
    "Provide at least one of dirPath or filePaths",
  );
});

Deno.test("extract_batch throws when dirPath is not a directory", async () => {
  const { context } = ctx();
  const { dir, paths } = await createTempPdfs([
    { name: "a.pdf", text: "Test" },
  ]);

  try {
    await assertRejects(
      () =>
        model.methods.extract_batch.execute(
          { dirPath: paths[0], recursive: false },
          context,
        ),
      Error,
      "Not a directory",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("extract_batch throws when directory has no PDFs", async () => {
  const { context } = ctx();
  const dir = await Deno.makeTempDir({ prefix: "swamp-pdf-test-" });
  await Deno.writeTextFile(`${dir}/readme.txt`, "no pdfs here");

  try {
    await assertRejects(
      () =>
        model.methods.extract_batch.execute(
          { dirPath: dir, recursive: false },
          context,
        ),
      Error,
      "No PDF files found",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("extract_batch throws when pattern matches nothing", async () => {
  const { context } = ctx();
  const { dir } = await createTempPdfs([
    { name: "report.pdf", text: "Test" },
  ]);

  try {
    await assertRejects(
      () =>
        model.methods.extract_batch.execute(
          { dirPath: dir, recursive: false, pattern: "^invoice-" },
          context,
        ),
      Error,
      "No PDF files found",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("extract_batch throws when filePaths entry is not a file", async () => {
  const { context } = ctx();
  const dir = await Deno.makeTempDir({ prefix: "swamp-pdf-test-" });

  try {
    await assertRejects(
      () =>
        model.methods.extract_batch.execute(
          { filePaths: [dir], recursive: false },
          context,
        ),
      Error,
      "Not a file",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── extract_batch: partial failure ──────────────────────────────────────────

Deno.test("extract_batch continues past corrupt files and reports successes", async () => {
  const { context, getWrittenResources } = ctx();
  const { dir, paths } = await createTempPdfs([
    { name: "good.pdf", text: "Valid content" },
  ]);
  // Write a corrupt "PDF" file.
  await Deno.writeFile(`${dir}/bad.pdf`, new Uint8Array([0, 1, 2, 3]));

  try {
    const result = await model.methods.extract_batch.execute(
      { dirPath: dir, recursive: false },
      context,
    );
    // bad.pdf fails but good.pdf still succeeds.
    assertEquals(result.dataHandles.length, 1);
    assertEquals(getWrittenResources()[0].name, "good");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("extract_batch throws when all files fail", async () => {
  const { context } = ctx();
  const dir = await Deno.makeTempDir({ prefix: "swamp-pdf-test-" });
  await Deno.writeFile(`${dir}/bad1.pdf`, new Uint8Array([0, 1, 2]));
  await Deno.writeFile(`${dir}/bad2.pdf`, new Uint8Array([3, 4, 5]));

  try {
    await assertRejects(
      () =>
        model.methods.extract_batch.execute(
          { dirPath: dir, recursive: false },
          context,
        ),
      Error,
      "All 2 PDF(s) failed",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── schema conformance ─────────────────────────────────────────────────────

Deno.test("written resource has all DocumentSchema fields", async () => {
  const { context, getWrittenResources } = ctx();
  const { dir, paths } = await createTempPdfs([
    { name: "schema-test.pdf", text: "Schema check" },
  ]);

  try {
    await model.methods.extract.execute({ filePath: paths[0] }, context);
    const data = getWrittenResources()[0].data as Record<string, unknown>;

    const requiredFields = [
      "filePath",
      "fileName",
      "markdown",
      "metadata",
      "extractedAt",
    ];
    for (const field of requiredFields) {
      assertExists(data[field], `Missing field: ${field}`);
    }

    const meta = data.metadata as Record<string, unknown>;
    const metaFields = [
      "title",
      "author",
      "subject",
      "creator",
      "producer",
      "pageCount",
      "creationDate",
      "modificationDate",
    ];
    for (const field of metaFields) {
      assertEquals(field in meta, true, `Missing metadata field: ${field}`);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── logging ────────────────────────────────────────────────────────────────

Deno.test("extract logs page count and filename", async () => {
  const { context, getLogs } = ctx();
  const { dir, paths } = await createTempPdfs([
    { name: "logged.pdf", text: "Log test" },
  ]);

  try {
    await model.methods.extract.execute({ filePath: paths[0] }, context);
    const infoLogs = getLogs().filter((l) => l.level === "info");
    assertEquals(infoLogs.length >= 1, true, "Expected at least one info log");
    assertStringIncludes(infoLogs[0].message, "page(s)");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("extract_batch logs file count and total pages", async () => {
  const { context, getLogs } = ctx();
  const { dir } = await createTempPdfs([
    { name: "a.pdf", text: "A" },
    { name: "b.pdf", text: "B" },
  ]);

  try {
    await model.methods.extract_batch.execute(
      { dirPath: dir, recursive: false },
      context,
    );
    const infoLogs = getLogs().filter((l) => l.level === "info");
    const batchLog = infoLogs.find((l) => l.message.includes("file(s)"));
    assertExists(batchLog, "Expected a batch summary log");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
