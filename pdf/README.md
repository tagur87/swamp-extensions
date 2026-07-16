# @tagur/pdf

PDF extraction model for [swamp](https://github.com/swamp-club/swamp).

Reads local PDF files and extracts their content as structured markdown with
best-effort detection of headings, tables, lists, and paragraphs. Also captures
PDF metadata (title, author, page count, creation/modification dates).

## Install

```bash
swamp extension pull @tagur/pdf
```

## Quick Start

```bash
# Create a model instance (no global args needed)
swamp model create @tagur/pdf my-pdf

# Extract a single PDF
swamp model method run my-pdf extract --input filePath=/path/to/document.pdf

# Extract all PDFs in a directory (factory pattern — one resource per file)
swamp model method run my-pdf extract_batch --input dirPath=/path/to/pdfs

# View the extracted markdown
swamp data get my-pdf document --json | jq -r '.attributes.markdown'

# Query all extracted documents
swamp data query 'modelName == "my-pdf"' --select '{"name": name, "pages": attributes.metadata.pageCount}'
```

## Methods

### extract

Parse a single local PDF file and produce structured markdown output.

**Arguments:**

| Name       | Type   | Required | Description                   |
| ---------- | ------ | -------- | ----------------------------- |
| `filePath` | string | yes      | Absolute path to the PDF file |

### extract_batch

Extract multiple PDFs — pass a directory, an explicit list of file paths, or
both. One `document` resource per file (factory pattern). Acquires the model
lock once and processes all files in a single execution, avoiding lock
contention from separate calls.

**Arguments:**

| Name        | Type     | Required | Description                                                        |
| ----------- | -------- | -------- | ------------------------------------------------------------------ |
| `dirPath`   | string   | no*      | Absolute path to a directory containing PDF files                  |
| `filePaths` | string[] | no*      | Explicit list of absolute paths to PDF files                       |
| `recursive` | boolean  | no       | Recurse into subdirectories (default: false; only applies to dirPath) |
| `pattern`   | string   | no       | Regex to filter file names (applied to base name only; only applies to dirPath) |

*At least one of `dirPath` or `filePaths` is required. Both can be provided —
results are deduplicated.

**Examples:**

```bash
# All PDFs in a directory
swamp model method run my-pdf extract_batch --input dirPath=/path/to/pdfs

# Explicit list of files
swamp model method run my-pdf extract_batch \
  --input 'filePaths:json=["/path/to/a.pdf", "/path/to/b.pdf"]'

# Directory with recursive filter
swamp model method run my-pdf extract_batch \
  --input dirPath=/path/to/pdfs \
  --input recursive=true \
  --input "pattern=report-.*2026"
```

### Output resources

Both methods produce `document` resources with these fields:

- `filePath` — source file path
- `fileName` — base file name
- `markdown` — extracted text as structured markdown
- `metadata.title` — PDF title
- `metadata.author` — PDF author
- `metadata.subject` — PDF subject
- `metadata.creator` — creator application
- `metadata.producer` — producer application
- `metadata.pageCount` — total pages
- `metadata.creationDate` — creation date
- `metadata.modificationDate` — modification date
- `extractedAt` — extraction timestamp

## Markdown Heuristics

The model applies best-effort structural detection:

- **Headings** — short standalone lines (not ending in punctuation) become `## ` headings
- **Tables** — pipe-delimited rows are preserved as markdown tables
- **Lists** — bullet (`-`, `*`, `+`) and numbered (`1.`, `2)`) patterns are kept
- **Paragraphs** — remaining text is grouped into paragraphs

## License

MIT
