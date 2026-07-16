/**
 * PDF extraction model for swamp.
 *
 * Reads a local PDF file and extracts its content as structured markdown with
 * best-effort detection of headings, tables, lists, and paragraphs. Also
 * captures PDF metadata (title, author, page count, dates).
 *
 * Methods: extract (single file), extract_batch (all PDFs in a directory —
 * factory pattern producing one resource per file).
 *
 * Uses unpdf (lightweight PDF.js wrapper) for parsing.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { extractText, getDocumentProxy } from "npm:unpdf@0.12.1";

// =============================================================================
// Schemas
// =============================================================================

/** Global arguments — no config needed for local file parsing. */
const GlobalArgsSchema = z.object({});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Metadata extracted from the PDF document info dictionary. */
const MetadataSchema = z.object({
  title: z.string().describe("PDF title from document info"),
  author: z.string().describe("PDF author from document info"),
  subject: z.string().describe("PDF subject from document info"),
  creator: z.string().describe("PDF creator application"),
  producer: z.string().describe("PDF producer application"),
  pageCount: z.number().describe("Total number of pages"),
  creationDate: z.string().describe("PDF creation date (ISO or raw)"),
  modificationDate: z.string().describe("PDF modification date (ISO or raw)"),
});

/** Schema for the extracted document resource. */
const DocumentSchema = z.object({
  filePath: z.string().describe("Absolute path to the source PDF"),
  fileName: z.string().describe("Base file name"),
  markdown: z.string().describe("Extracted content as structured markdown"),
  metadata: MetadataSchema,
  extractedAt: z.iso.datetime(),
});

// =============================================================================
// Method context
// =============================================================================

type MethodContext = {
  globalArgs: GlobalArgs;
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  logger?: { info: (msg: string, props?: Record<string, unknown>) => void };
};

// =============================================================================
// Text-to-markdown conversion
// =============================================================================

/** Detect if a line looks like a table row (pipe-delimited). */
function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") &&
    trimmed.split("|").length >= 3;
}

/** Detect if a line is a table separator (e.g. |---|---|). */
function isTableSeparator(line: string): boolean {
  return /^\|[\s:?-]+(\|[\s:?-]+)+\|$/.test(line.trim());
}

/** Detect if a line looks like a list item. */
function isListItem(line: string): boolean {
  return /^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line);
}

/**
 * Convert raw PDF text to structured markdown.
 *
 * Applies best-effort heuristics: short standalone lines become headings,
 * pipe-delimited content stays as tables, bullet/numbered patterns become
 * list items, and everything else becomes paragraphs.
 */
function textToMarkdown(raw: string): string {
  const lines = raw.split("\n");
  const output: string[] = [];
  let inTable = false;
  let prevBlank = true;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const nextLine = i + 1 < lines.length ? lines[i + 1]?.trim() ?? "" : "";

    if (trimmed === "") {
      if (!inTable) output.push("");
      prevBlank = true;
      inTable = false;
      continue;
    }

    if (isTableRow(trimmed) || isTableSeparator(trimmed)) {
      if (!inTable && output.length > 0 && output[output.length - 1] !== "") {
        output.push("");
      }
      output.push(trimmed);
      inTable = true;
      prevBlank = false;
      continue;
    }
    inTable = false;

    if (isListItem(trimmed)) {
      output.push(trimmed);
      prevBlank = false;
      continue;
    }

    if (
      prevBlank && trimmed.length <= 80 && trimmed.length > 0 &&
      (nextLine === "" || i === lines.length - 1) &&
      !trimmed.endsWith(".") && !trimmed.endsWith(",") &&
      !trimmed.endsWith(";")
    ) {
      output.push(`## ${trimmed}`);
      prevBlank = false;
      continue;
    }

    output.push(trimmed);
    prevBlank = false;
  }

  return output
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Parse a PDF date string (D:YYYYMMDDHHmmSS or ISO) into a readable string. */
function parsePdfDate(raw: unknown): string {
  if (!raw) return "";
  const s = String(raw);
  const m = s.match(/^D:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (m) {
    return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  }
  if (raw instanceof Date) return raw.toISOString();
  return s;
}

/** Sanitize a file name into a safe swamp data-instance name. */
function instanceName(name: string): string {
  return name
    .replace(/\.pdf$/i, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "document";
}

// =============================================================================
// Shared extraction logic
// =============================================================================

/** Result of extracting a single PDF file. */
interface ExtractionResult {
  filePath: string;
  fileName: string;
  markdown: string;
  metadata: {
    title: string;
    author: string;
    subject: string;
    creator: string;
    producer: string;
    pageCount: number;
    creationDate: string;
    modificationDate: string;
  };
}

/** Extract text and metadata from a single PDF file. */
async function extractPdf(filePath: string): Promise<ExtractionResult> {
  const buffer = await Deno.readFile(filePath);
  const doc = await getDocumentProxy(new Uint8Array(buffer));
  try {
    const { text } = await extractText(doc, { mergePages: true });
    const docMeta = await doc.getMetadata().catch(() => null);
    const info = (docMeta?.info ?? {}) as Record<string, unknown>;

    return {
      filePath,
      fileName: filePath.split("/").pop() ?? filePath,
      markdown: textToMarkdown(text),
      metadata: {
        title: String(info.Title ?? ""),
        author: String(info.Author ?? ""),
        subject: String(info.Subject ?? ""),
        creator: String(info.Creator ?? ""),
        producer: String(info.Producer ?? ""),
        pageCount: doc.numPages,
        creationDate: parsePdfDate(info.CreationDate),
        modificationDate: parsePdfDate(info.ModDate),
      },
    };
  } finally {
    doc.destroy();
  }
}

/** Collect all *.pdf files in a directory (non-recursive or recursive). */
async function findPdfs(
  dirPath: string,
  recursive: boolean,
): Promise<string[]> {
  const paths: string[] = [];
  for await (const entry of Deno.readDir(dirPath)) {
    const full = `${dirPath}/${entry.name}`;
    if (entry.isFile && entry.name.toLowerCase().endsWith(".pdf")) {
      paths.push(full);
    } else if (recursive && entry.isDirectory) {
      paths.push(...await findPdfs(full, true));
    }
  }
  return paths.sort();
}

// =============================================================================
// Model definition
// =============================================================================

/** PDF extraction model definition for swamp. */
export const model = {
  type: "@tagur/pdf" as const,
  version: "2026.07.16.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    document: {
      description: "Extracted PDF content as structured markdown with metadata",
      schema: DocumentSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    extract: {
      description:
        "Extract text content from a single local PDF file as structured markdown",
      arguments: z.object({
        filePath: z.string().describe(
          "Absolute path to the PDF file to extract",
        ),
      }),
      execute: async (
        args: { filePath: string },
        context: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const stat = await Deno.stat(args.filePath);
        if (!stat.isFile) {
          throw new Error(`Not a file: ${args.filePath}`);
        }

        const result = await extractPdf(args.filePath);
        const dataName = instanceName(result.fileName);

        const handle = await context.writeResource("document", dataName, {
          ...result,
          extractedAt: new Date().toISOString(),
        });

        context.logger?.info("Extracted {pages} page(s) from {file}", {
          pages: result.metadata.pageCount,
          file: result.fileName,
        });

        return { dataHandles: [handle] };
      },
    },

    extract_batch: {
      description:
        "Extract multiple PDFs — pass a directory, a list of file paths, or both. One document resource per file (factory pattern)",
      arguments: z.object({
        dirPath: z.string().optional().describe(
          "Absolute path to a directory containing PDF files",
        ),
        filePaths: z.array(z.string()).optional().describe(
          "Explicit list of absolute paths to PDF files",
        ),
        recursive: z.boolean().default(false).describe(
          "Recurse into subdirectories (only applies to dirPath)",
        ),
        pattern: z.string().optional().describe(
          "Optional regex to filter file names (applied to base name, not full path; only applies to dirPath)",
        ),
      }),
      execute: async (
        args: {
          dirPath?: string;
          filePaths?: string[];
          recursive: boolean;
          pattern?: string;
        },
        context: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        if (!args.dirPath && (!args.filePaths || args.filePaths.length === 0)) {
          throw new Error(
            "Provide at least one of dirPath or filePaths",
          );
        }

        let pdfPaths: string[] = [];

        if (args.dirPath) {
          const stat = await Deno.stat(args.dirPath);
          if (!stat.isDirectory) {
            throw new Error(`Not a directory: ${args.dirPath}`);
          }
          let dirPdfs = await findPdfs(args.dirPath, args.recursive);
          if (args.pattern) {
            const re = new RegExp(args.pattern);
            dirPdfs = dirPdfs.filter((p) => re.test(p.split("/").pop() ?? ""));
          }
          pdfPaths.push(...dirPdfs);
        }

        if (args.filePaths) {
          for (const fp of args.filePaths) {
            const stat = await Deno.stat(fp);
            if (!stat.isFile) {
              throw new Error(`Not a file: ${fp}`);
            }
            pdfPaths.push(fp);
          }
        }

        const seen = new Set<string>();
        pdfPaths = pdfPaths.filter((p) => {
          if (seen.has(p)) return false;
          seen.add(p);
          return true;
        });

        if (pdfPaths.length === 0) {
          throw new Error(
            `No PDF files found${args.dirPath ? ` in ${args.dirPath}` : ""}${
              args.pattern ? ` matching /${args.pattern}/` : ""
            }`,
          );
        }

        context.logger?.info("Processing {count} PDF(s)", {
          count: pdfPaths.length,
        });

        const handles: Array<{ name: string }> = [];
        const failures: Array<{ file: string; error: string }> = [];
        const usedNames = new Set<string>();
        let totalPages = 0;

        for (const pdfPath of pdfPaths) {
          try {
            const result = await extractPdf(pdfPath);

            let dataName = instanceName(result.fileName);
            if (usedNames.has(dataName)) {
              let suffix = 2;
              while (usedNames.has(`${dataName}-${suffix}`)) suffix++;
              dataName = `${dataName}-${suffix}`;
            }
            usedNames.add(dataName);

            const handle = await context.writeResource("document", dataName, {
              ...result,
              extractedAt: new Date().toISOString(),
            });
            handles.push(handle);
            totalPages += result.metadata.pageCount;
          } catch (err) {
            const fileName = pdfPath.split("/").pop() ?? pdfPath;
            const msg = err instanceof Error ? err.message : String(err);
            failures.push({ file: fileName, error: msg });
            context.logger?.info("Failed to extract {file}: {error}", {
              file: fileName,
              error: msg,
            });
          }
        }

        if (handles.length === 0 && failures.length > 0) {
          throw new Error(
            `All ${failures.length} PDF(s) failed extraction: ${
              failures.map((f) => `${f.file} (${f.error})`).join(", ")
            }`,
          );
        }

        context.logger?.info(
          "Extracted {files} file(s), {pages} total page(s){failures}",
          {
            files: handles.length,
            pages: totalPages,
            failures: failures.length > 0 ? `, ${failures.length} failed` : "",
          },
        );

        return { dataHandles: handles };
      },
    },
  },
};
