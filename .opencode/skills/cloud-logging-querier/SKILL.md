---
name: cloud-logging-querier
description: How to query Google Cloud Logging for application-layer errors from a specific Neo4j database on a GKE cluster. Covers the cloudlogging_query tool, time window usage, noise exclusions, neo4j-operator log structure, and how to interpret and integrate results into the incident timeline.
---

## What I do

I teach you how to query Google Cloud Logging for application and Kubernetes-layer errors scoped to a specific database and cluster. This complements the GCS kernel log analysis by showing what the Neo4j operator and infrastructure agents observed — before you dive into raw kernel logs.

## When to use

Use `cloudlogging_query` as a fast first triage step when the user provides a GCP project ID, cluster name, and database ID. It answers: "did the operator see anything wrong with this database?" If the operator was reporting `context deadline exceeded` or reconciler failures, that is the application-layer signal that a storage or network failure was already affecting the database — and you can then correlate the timestamps with kernel log signals.

## Required inputs

| Input | Example | Where to ask |
|-------|---------|--------------|
| `project` | `my-gcp-project` | User must provide |
| `cluster_name` | `production-clstr-445566` | User must provide |
| `database_id` | `2aaff013` | User must provide |

## Time window

The tool defaults to the **last 60 seconds** if no `start`/`end` are provided. For incident investigation, always pass an explicit time window:

    start: "2026-01-15T22:25:00Z"
    end:   "2026-01-15T22:35:00Z"

Use a window of 5–15 minutes around the suspected incident time for initial triage. Widen if no results are returned.

If the window is correct but results are empty, the incident may have produced no operator-visible errors (e.g. a silent disk failure before the filesystem abort). Proceed to kernel logs regardless.

## Noise exclusions

The following containers are excluded from every query. They fire constantly on all clusters and carry no incident signal:

| Container | Noise pattern | Reason excluded |
|-----------|--------------|-----------------|
| `gke-metadata-server` | `Pod not found after refresh` ~every second | GKE system component churning on completed/missing backup pods — always present |
| `node-exporter` | `error gathering metrics: node_filesystem_*` every ~6s per node | Prometheus duplicate metrics scrape bug — chronic, unrelated to incidents |
| `recorder` (cnrm-system) | `error listing objects for *.cnrm.cloud.google.com` | Config Connector CRD not installed — background noise on all clusters |

## neo4j-operator log structure

The `neo4j-operator` container emits structured JSON logs. The fields that matter:

| Field | Meaning |
|-------|---------|
| `jsonPayload.error` | The precise error string — prefer this over `message` |
| `jsonPayload.message` | Controller-runtime wrapper summary (e.g. "Reconciler error") — less specific |
| `jsonPayload.controller` | Which reconciler failed: `backupschedule`, `neo4jdatabase`, `backup`, etc. |
| `jsonPayload.name` | The database ID (e.g. `2aaff013-backup`) |
| `jsonPayload.eventTime` | Canonical event timestamp — more precise than `timestamp` |

### Double-log pattern

Every reconcile error produces **two log entries** with the same `eventTime`:

- One from `controller/controller.go` — has `jsonPayload.message` = "Reconciler error", no `error` field
- One from the specific controller (e.g. `backup/backup_controller.go`) — has the full error in `jsonPayload.message`, no `error` field

The `cloudlogging_query` tool deduplicates these pairs automatically, keeping only the more informative entry.

## Key error patterns

| Error string | Meaning |
|-------------|---------|
| `context deadline exceeded` | Operator timed out trying to reach the database API — strong signal of network or storage failure |
| `object has been modified; please apply your changes to the latest version` | High reconcile churn on a resource — often a symptom of something thrashing upstream, not the root cause |
| `Reconciler error` with HTTP 4xx/5xx in the error | Operator cannot reach the database or Kubernetes API |
| `unable to read itable` or similar filesystem errors in error text | Storage failure has surfaced to the application layer |

## Output format

The tool returns one line per unique error after deduplication:

    2026-01-15T22:28:30Z [ERROR] neo4j-operator (backupschedule/2aaff013-backup): context deadline exceeded  (repeated 4x, last 2026-01-15T22:31:45Z)

Followed by a summary line:

    3 unique error(s) from 24 raw entries (2026-01-15T22:25:00Z to 2026-01-15T22:35:00Z)

If the limit is hit, a warning is appended — increase `limit` or narrow the time window.

## Timeline integration

- Use `neo4j-operator` (or `infra-agent`, etc.) as the **Source** column value
- Timestamps are RFC3339 UTC — convert to `Mon DD HH:MM:SS` format to match kernel log events
- Cloud Logging errors typically appear **after** the kernel-level failure — use them to establish the detection gap and application impact, not the root cause
- If the first `context deadline exceeded` timestamp matches closely with a kernel `Aborting journal` or `EXT4-fs error`, that confirms the causal chain reached the application layer
