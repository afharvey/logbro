# logbro

An AI-powered incident investigation agent for Neo4j databases on Kubernetes. It can query Google Cloud Logging for operator errors, analyse kernel and system logs from a GCS bucket, or both — and prints a plain text incident summary. An HTML timeline report is available on request.

## Prerequisites

- [OpenCode](https://opencode.ai) installed and running
- [Bun](https://bun.sh) installed (`curl -fsSL https://bun.sh/install | bash`)
- `gcloud` CLI installed and authenticated (`gcloud auth login`)
- For Cloud Logging queries: `roles/logging.viewer` on the GCP project
- For GCS kernel log analysis: read access to the GCS bucket containing node logs

## Setup

Clone the repository and open it in OpenCode:

```bash
git clone https://github.com/afharvey/logbro
cd logbro
opencode
```

No additional installation steps are required. OpenCode discovers the agent, skills, and tools automatically from the `.opencode/` directory.

## Usage

Invoke the agent in the OpenCode TUI using `@incident-investigator`. The agent will ask for any missing information before proceeding.

**Cloud Logging only — query operator errors for a specific database:**

```
@incident-investigator I'm investigating database 2aaff013 on cluster
production-clstr-445566, project my-gcp-project
```

The agent will ask for a time range ("now", "last 30 minutes", "around 22:28 Jan 15", etc.), query Cloud Logging, and print a plain text summary.

**GCS kernel logs only — analyse node-level storage failure:**

```
@incident-investigator The GCS bucket is gs://my-cluster-logs/node-logs/
Investigate the storage failure around Jan 15 22:28 UTC.
```

**Both — full investigation merging operator errors and kernel logs:**

```
@incident-investigator Database 2aaff013 on cluster production-clstr-445566,
project my-gcp-project. GCS bucket: gs://my-cluster-logs/node-logs/
Investigate around Jan 15 22:28 UTC.
```

**Sample dataset:**

```
@incident-investigator The GCS bucket is gs://devafharvey22-hackathon/azure-disk-logs/
Investigate the storage failure around Jan 15 22:28 UTC.
```

## What the agent does

1. Asks what you want to investigate (Cloud Logging, GCS bucket, or both) and for what time range
2. Loads only the skills it needs for the selected investigation tracks
3. Queries Cloud Logging and/or searches kernel logs depending on what was provided
4. Prints a plain text incident summary
5. Asks if you want an HTML incident report — writes `timeline.html` if yes

## Output

**Plain text summary** — always printed. Covers the key events in chronological order, grouped by phase (Healthy, VF Reset, I/O Failure, Silent Failure, Detection, Resolution) with a detection gap calculation.

**HTML report** — written on request to the directory where you ran `opencode`. Self-contained with inline CSS, no external dependencies. Includes the full timeline table and a detection gap summary section.

## Supported log sources

### Google Cloud Logging

Queries the `neo4j-operator` and related containers for reconciler errors scoped to a specific cluster and database. Known-noisy system containers (`gke-metadata-server`, `node-exporter`, `recorder`) are excluded automatically.

### GCS kernel logs

| File | Contents |
|------|----------|
| `kern.log` / `kern.log.N` | Kernel messages — primary source for storage events |
| `kern.log.N.gz` | Older compressed kernel log rotations |
| `dmesg` / `dmesg.0` | Kernel ring buffer snapshots |
| `syslog` / `syslog.N` | All system messages including systemd |
| `messages` / `messages.N` | General system messages |
| `warn` / `warn.N` | Warnings and above only |

Compressed `.gz` files are decompressed automatically.

## How it works

### Tools

| Tool | Description |
|------|-------------|
| `cloudlogging_query` | Queries Google Cloud Logging for errors scoped to a cluster and database, with two-pass deduplication |
| `gcs_list` | Lists files in a GCS bucket path with sizes |
| `gcs_grep_count` | Counts matching lines before fetching (safety check) |
| `gcs_grep` | Streams and greps a GCS log file, with optional time-window filtering and context lines |
| `write_timeline` | Writes the HTML report to disk |

### Skills

| Skill | Description |
|-------|-------------|
| `cloud-logging-querier` | When to use Cloud Logging, required inputs, noise exclusions, neo4j-operator log structure, key error patterns |
| `gcs-log-fetcher` | Log file types, rotation conventions, safe fetching protocol |
| `kernel-log-parser` | Syslog line format, subsystem prefixes, uptime tiebreaking |
| `storage-incident-analyzer` | Signal patterns, causal chain, two-pass search strategy |
| `timeline-builder` | Event merging, deduplication, phase grouping, HTML output format |
