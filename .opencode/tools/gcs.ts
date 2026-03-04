import { tool } from "@opencode-ai/plugin"

const SAFE_LINE_THRESHOLD = 200

function isGzipped(uri: string): boolean {
  return uri.endsWith(".gz")
}

// Runs gcloud storage cat and optionally decompresses, returning raw stdout as a Buffer.
// We use Bun.spawn so we can pipe stdout directly into subsequent grep processes
// without passing anything through a shell string — avoiding quoting issues entirely.
async function catToText(uri: string): Promise<string> {
  if (isGzipped(uri)) {
    const cat = Bun.spawn(["gcloud", "storage", "cat", uri], { stdout: "pipe" })
    const gunzip = Bun.spawn(["gunzip"], { stdin: cat.stdout, stdout: "pipe" })
    return new Response(gunzip.stdout).text()
  }
  const cat = Bun.spawn(["gcloud", "storage", "cat", uri], { stdout: "pipe" })
  return new Response(cat.stdout).text()
}

// Runs grep -E against text supplied via stdin, returning matched lines.
// Using a grep subprocess means ERE syntax (including \[, \d, etc.) is handled
// natively rather than requiring translation to JS regex syntax.
async function grepE(text: string, pattern: string): Promise<string[]> {
  const proc = Bun.spawn(["grep", "-E", pattern], {
    stdin: new TextEncoder().encode(text),
    stdout: "pipe",
    stderr: "ignore",
  })
  const out = await new Response(proc.stdout).text()
  // grep exits 1 when no lines match — that's fine, not an error
  return out === "" ? [] : out.split("\n").filter(l => l !== "")
}

// Runs grep -E with -B/-A context lines against text supplied via stdin.
async function grepEContext(text: string, pattern: string, contextLines: number): Promise<string[]> {
  const proc = Bun.spawn(["grep", "-E", `-B${contextLines}`, `-A${contextLines}`, pattern], {
    stdin: new TextEncoder().encode(text),
    stdout: "pipe",
    stderr: "ignore",
  })
  const out = await new Response(proc.stdout).text()
  return out === "" ? [] : out.split("\n").filter(l => l !== "")
}

// Pre-filters lines by a fixed time-window string, then applies ERE grep.
async function applyGrep(text: string, pattern: string, timeFilter?: string): Promise<string[]> {
  const filtered = timeFilter
    ? text.split("\n").filter(line => line.includes(timeFilter)).join("\n")
    : text
  return grepE(filtered, pattern)
}

// Same as applyGrep but returns surrounding context lines for each match.
async function applyGrepWithContext(
  text: string,
  pattern: string,
  contextLines: number,
  timeFilter?: string
): Promise<string[]> {
  const filtered = timeFilter
    ? text.split("\n").filter(line => line.includes(timeFilter)).join("\n")
    : text
  return grepEContext(filtered, pattern, contextLines)
}

export const list = tool({
  description:
    "List files in a GCS bucket path with sizes and timestamps. Use this first to discover available log files before fetching any content.",
  args: {
    bucket_path: tool.schema
      .string()
      .describe("GCS path to list, e.g. gs://my-bucket/logs/"),
  },
  async execute(args) {
    const result = await Bun.$`gcloud storage ls -l ${args.bucket_path}`.text()
    return result.trim()
  },
})

export const grep_count = tool({
  description:
    "Count how many lines in a GCS log file match a grep pattern, without returning the content. " +
    "Always call this before gcs_grep to check if the result is safe to fetch. " +
    "Returns the line count and whether it is safe to fetch (under 200 lines). " +
    "If count is too high, refine your pattern or add a time_filter before calling gcs_grep.",
  args: {
    uri: tool.schema
      .string()
      .describe("Full GCS URI of the log file, e.g. gs://my-bucket/logs/kern.log.1"),
    pattern: tool.schema
      .string()
      .describe("Extended regex (ERE) pattern to match"),
    time_filter: tool.schema
      .string()
      .optional()
      .describe(
        "Optional plain string to pre-filter lines by timestamp before applying pattern, " +
        "e.g. 'Jan 15 22:2' to narrow to a specific time window."
      ),
  },
  async execute(args) {
    const text = await catToText(args.uri)
    const matched = await applyGrep(text, args.pattern, args.time_filter)
    const count = matched.length
    const safe = count <= SAFE_LINE_THRESHOLD

    return [
      `Match count: ${count}`,
      `Safe to fetch: ${safe ? "yes" : "no"} (threshold: ${SAFE_LINE_THRESHOLD} lines)`,
      safe
        ? "You can proceed with gcs_grep using the same pattern."
        : "Count exceeds threshold. Refine your pattern or add/narrow the time_filter before calling gcs_grep.",
    ].join("\n")
  },
})

export const grep = tool({
  description:
    "Stream a GCS log file (decompressing .gz automatically) and return lines matching a pattern. " +
    "Always call gcs_grep_count first to verify the result is under 200 lines. " +
    "Supports optional time window pre-filtering and context lines around each match. " +
    "Output is capped at max_lines; a warning is appended if the cap is hit.",
  args: {
    uri: tool.schema
      .string()
      .describe("Full GCS URI of the log file, e.g. gs://my-bucket/logs/kern.log.1"),
    pattern: tool.schema
      .string()
      .describe("Extended regex (ERE) pattern to match"),
    time_filter: tool.schema
      .string()
      .optional()
      .describe(
        "Optional plain string to pre-filter lines by timestamp before applying pattern, " +
        "e.g. 'Jan 15 22:2' to narrow to a specific time window."
      ),
    context_lines: tool.schema
      .number()
      .optional()
      .describe(
        "Number of lines of context to show before and after each match (like grep -B and -A). " +
        "Default 0. Use 3-5 when investigating the cause of a specific event."
      ),
    max_lines: tool.schema
      .number()
      .optional()
      .describe(`Maximum lines to return. Default ${SAFE_LINE_THRESHOLD}.`),
  },
  async execute(args) {
    const text = await catToText(args.uri)
    const max = args.max_lines ?? SAFE_LINE_THRESHOLD
    const ctx = args.context_lines ?? 0

    const matched =
      ctx > 0
        ? await applyGrepWithContext(text, args.pattern, ctx, args.time_filter)
        : await applyGrep(text, args.pattern, args.time_filter)

    // Remove any trailing empty strings from the split before capping
    while (matched.length > 0 && matched[matched.length - 1] === "") {
      matched.pop()
    }

    const capped = matched.length > max

    if (capped) {
      matched.splice(max)
      matched.push(
        `[OUTPUT CAPPED at ${max} lines. Re-run with a narrower pattern or time_filter to see all results.]`
      )
    }

    return matched.join("\n")
  },
})
