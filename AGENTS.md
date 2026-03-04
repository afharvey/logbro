# logbro

AI-powered incident investigation agent for Linux storage failures on Kubernetes nodes.
Point it at a GCS bucket containing node logs and it produces a structured HTML incident timeline.

## How to use

In the OpenCode TUI, invoke the agent:

    @incident-investigator The GCS bucket is gs://my-cluster-logs/node-logs/
    Investigate the storage failure around Jan 15 22:28 UTC.

Sample dataset: `gs://devafharvey22-hackathon/azure-disk-logs/`

## Project structure

    .opencode/
      agents/incident-investigator.md   # subagent: procedure, permissions, tool list
      skills/gcs-log-fetcher/           # log file types, rotation, safe fetch protocol
      skills/kernel-log-parser/         # syslog line format, subsystem prefixes
      skills/storage-incident-analyzer/ # signal dictionary, causal chain, two-pass strategy
      skills/timeline-builder/          # event merging, dedup, HTML output spec
      tools/gcs.ts                      # gcs_list, gcs_grep_count, gcs_grep
      tools/write_timeline.ts           # write_timeline

## Custom tool names

OpenCode registers tools as `<filename>_<exportname>` for named exports, or `<filename>`
for a default export. The actual registered names are:

- `gcs_list` — lists files in a GCS bucket path
- `gcs_grep_count` — counts matching lines before fetching (safety check)
- `gcs_grep` — fetches matching lines from a GCS log file
- `write_timeline` — writes the finished HTML to the user's working directory

The agent frontmatter and skill prompts already reference these names correctly.

## Key constraints

- Never fetch a GCS file whole — always call `gcs_grep_count` before `gcs_grep`
- If count exceeds 200 lines, refine the pattern or add a `time_filter` before fetching
- `gcs.ts` uses `Bun.spawn()` directly — not `Bun.$\`...\`` — to avoid shell quoting bugs with `|`, `(`, `)`
- grep patterns are passed to a `grep -E` subprocess via stdin — not `new RegExp()` — to handle ERE syntax like `\[`
- SKILL.md files use 4-space indented code blocks only — no triple-backtick fences (trips OpenCode's ripgrep extractor)

## Output

Writes `timeline.html` to the directory where `opencode` was launched.
The file is self-contained HTML with inline CSS — no external dependencies.

## Known issues / history

- Tool double-prefix bug: if a tool file `foo.ts` exports `export const foo_bar`, OpenCode
  registers it as `foo_foo_bar`. Fixed by using short export names (e.g. `list`, not `gcs_list`)
  so `gcs.ts` → `gcs_list`, and using `export default` for `write_timeline.ts`.
- SKILL.md triple-backtick fences cause `RipgrepExtractionFailedError` at skill load time.
  All code examples in skills use 4-space indentation instead.
