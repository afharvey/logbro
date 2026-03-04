import { tool } from "@opencode-ai/plugin"

const DEFAULT_LIMIT = 50

// Strip variable parts from error strings so repeated errors with different
// UUIDs or resource versions collapse to the same signature.
function normalise(s: string): string {
  return s
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/resourceVersion "[^"]+"/g, 'resourceVersion "<rv>"')
}

// Extract the core error from a message string. The backup controller wraps
// errors with a "Unable to update status of X: <error>" prefix — strip it so
// the core error matches the bare error string from the backupschedule controller.
function coreError(s: string): string {
  const match = s.match(/:\s+(.+)$/)
  // Only strip the prefix if it looks like a wrapper (starts with "Unable to"
  // or "Error in controller") — avoid stripping meaningful single-colon errors.
  if (match && /^(Unable to|Error in controller)/.test(s)) {
    return match[1].trim()
  }
  return s
}

export const query = tool({
  description:
    "Query Google Cloud Logging for errors from a specific database on a specific GKE cluster. " +
    "Returns deduplicated, human-readable error lines. " +
    "Defaults to the last 60 seconds if no time range is provided. " +
    "Known-noisy system containers (gke-metadata-server, node-exporter, recorder) are excluded automatically.",
  args: {
    project: tool.schema
      .string()
      .describe("GCP project ID, e.g. 'my-gcp-project'"),
    cluster_name: tool.schema
      .string()
      .describe("GKE cluster name, e.g. 'production-clstr-445566'"),
    database_id: tool.schema
      .string()
      .describe("Database ID to search for, e.g. '2aaff013'"),
    start: tool.schema
      .string()
      .optional()
      .describe("Start of time window as ISO8601 UTC, e.g. '2026-01-15T22:25:00Z'. Defaults to 60 seconds ago."),
    end: tool.schema
      .string()
      .optional()
      .describe("End of time window as ISO8601 UTC, e.g. '2026-01-15T22:30:00Z'. Defaults to now."),
    limit: tool.schema
      .number()
      .optional()
      .describe(`Maximum raw log entries to fetch before deduplication. Default ${DEFAULT_LIMIT}. Increase if limit-hit warning appears.`),
  },
  async execute(args) {
    const now = new Date()
    const end = args.end ?? now.toISOString().replace(/\.\d+Z$/, "Z")
    const start = args.start ?? new Date(now.getTime() - 60_000).toISOString().replace(/\.\d+Z$/, "Z")
    const limit = args.limit ?? DEFAULT_LIMIT

    const filter = [
      `resource.labels.cluster_name="${args.cluster_name}"`,
      `SEARCH("${args.database_id}")`,
      `severity>=ERROR`,
      `-resource.labels.container_name="gke-metadata-server"`,
      `-resource.labels.container_name="node-exporter"`,
      `-resource.labels.container_name="recorder"`,
      `timestamp>="${start}"`,
      `timestamp<="${end}"`,
    ].join("\n")

    // Use Bun.spawn (not Bun.$) to avoid shell quoting issues with the filter
    // string containing quotes, newlines, and minus signs.
    const proc = Bun.spawn(
      [
        "gcloud", "logging", "read", filter,
        "--project", args.project,
        "--order", "asc",
        "--format", "json",
        "--limit", String(limit),
      ],
      { stdout: "pipe", stderr: "pipe" }
    )

    const [rawOut, rawErr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])

    await proc.exited

    if (!rawOut.trim() || rawOut.trim() === "[]") {
      const note = rawErr.trim() ? `\ngcloud stderr: ${rawErr.trim()}` : ""
      return `No errors found for database "${args.database_id}" on cluster "${args.cluster_name}" between ${start} and ${end}.${note}`
    }

    let entries: any[]
    try {
      entries = JSON.parse(rawOut)
    } catch {
      return `Failed to parse gcloud output.\nstdout: ${rawOut.slice(0, 500)}\nstderr: ${rawErr.slice(0, 500)}`
    }

    // --- Pass 1: drop controller-runtime pair duplicates ---
    // Each reconcile error produces two log entries with the same eventTime:
    // one from controller/controller.go (message only) and one from the
    // specific controller file (error field set). Keep only the one with
    // jsonPayload.error set; if both or neither have it, keep the first seen.
    const seenPairs = new Set<string>()
    const deduped: any[] = []

    for (const entry of entries) {
      const jp = entry.jsonPayload ?? {}
      const eventTime: string = jp.eventTime ?? ""
      const errorText: string = jp.error ?? jp.message ?? ""
      const pairKey = `${eventTime}|${normalise(errorText)}`

      if (seenPairs.has(pairKey)) {
        // Already have an entry for this event — replace if this one has
        // jsonPayload.error (more specific) and previous didn't.
        const prev = deduped.find(e => {
          const pjp = e.jsonPayload ?? {}
          const pet = pjp.eventTime ?? ""
          const pe = pjp.error ?? pjp.message ?? ""
          return `${pet}|${normalise(pe)}` === pairKey
        })
        if (prev && !(prev.jsonPayload?.error) && jp.error) {
          // Swap in the more informative entry
          const idx = deduped.indexOf(prev)
          deduped[idx] = entry
        }
        continue
      }
      seenPairs.add(pairKey)
      deduped.push(entry)
    }

    // --- Pass 2: collapse repeated identical messages across the window ---
    type SigInfo = { count: number; firstTs: string; lastTs: string; line: string; hasError: boolean }
    const seenSigs = new Map<string, SigInfo>()
    const orderedSigs: string[] = []

    for (const entry of deduped) {
      const jp = entry.jsonPayload ?? {}
      const ts = (entry.timestamp as string).slice(0, 19) + "Z"
      const severity: string = entry.severity ?? "ERROR"
      const container: string = entry.resource?.labels?.container_name ?? "unknown"
      const controller: string = jp.controller ?? ""
      const error: string = jp.error ?? jp.message ?? "(no message)"
      const hasError = !!jp.error
      // Prefer jsonPayload.name, fall back to nested resource-specific fields
      const name: string =
        jp.name ??
        jp.BackupSchedule?.name ??
        jp.Neo4jDatabase?.name ??
        ""

      const sig = normalise(`${container}|${coreError(error)}`)

      if (seenSigs.has(sig)) {
        const info = seenSigs.get(sig)!
        info.count++
        info.lastTs = ts
        // Upgrade to the more informative entry if we now have one with .error set
        if (!info.hasError && hasError) {
          const label = controller && name ? `${controller}/${name}` : controller || name || container
          info.line = `${ts} [${severity}] ${container} (${label}): ${error}`
          info.hasError = true
        }
        continue
      }

      const label = controller && name
        ? `${controller}/${name}`
        : controller || name || container
      const line = `${ts} [${severity}] ${container} (${label}): ${error}`

      seenSigs.set(sig, { count: 1, firstTs: ts, lastTs: ts, line, hasError })
      orderedSigs.push(sig)
    }

    // --- Format output ---
    const lines: string[] = []
    for (const sig of orderedSigs) {
      const info = seenSigs.get(sig)!
      const repeat = info.count > 1 ? `  (repeated ${info.count}x, last ${info.lastTs})` : ""
      lines.push(info.line + repeat)
    }

    const summary = `\n${orderedSigs.length} unique error(s) from ${entries.length} raw entries (${start} to ${end})`
    if (entries.length >= limit) {
      lines.push(`\n[LIMIT HIT at ${limit} raw entries. Increase limit or narrow the time window to see all results.]`)
    }

    return lines.join("\n") + summary
  },
})
