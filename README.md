# logbro

An AI-powered incident investigation agent for Linux storage failures on Kubernetes nodes. Point it at a GCS bucket containing node logs and it produces a structured HTML incident timeline.

## Prerequisites

- [OpenCode](https://opencode.ai) installed and running
- [Bun](https://bun.sh) installed (`curl -fsSL https://bun.sh/install | bash`)
- `gcloud` CLI installed and authenticated (`gcloud auth login`)
- Read access to the GCS bucket containing the node logs

## Setup

Clone the repository and open it in OpenCode:

```bash
git clone https://github.com/afharvey/logbro
cd logbro
opencode
```

No additional installation steps are required. OpenCode discovers the agent, skills, and tools automatically from the `.opencode/` directory.

## Usage

In the OpenCode TUI, invoke the agent using `@incident-investigator` and provide the GCS bucket path and the approximate time of the incident:

```
@incident-investigator The GCS bucket is gs://my-cluster-logs/node-logs/
Investigate the storage failure around Jan 15 22:28 UTC.
```

**Example using the sample dataset included in this repo:**

```
@incident-investigator The GCS bucket is gs://devafharvey22-hackathon/azure-disk-logs/
Investigate the storage failure around Jan 15 22:28 UTC.
```

The agent will:

1. List the available log files in the bucket
2. Run targeted grep searches across the relevant log files — never reading an entire file
3. Correlate events across log sources into a structured timeline
4. Write `timeline.html` to your current working directory
5. Confirm the output path

## Output

The agent writes a self-contained `timeline.html` file to the directory where you ran `opencode`. Open it in any browser — no internet connection required.

The timeline is organised into phases:

- **Healthy** — normal operation before any failure signal
- **VF Reset** — host maintenance event
- **I/O Failure** — first errors through journal abort
- **Silent Failure** — filesystem dead, Kubernetes unaware
- **Detection & Resolution** — human response and fix

A detection gap summary at the bottom shows the time elapsed between the first failure signal in the logs and the first human awareness of the incident.

## Supported log files

The agent understands the following Linux node log types stored in GCS:

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

The agent uses three custom OpenCode tools:

- **`gcs_list`** — lists files in the bucket with sizes
- **`gcs_grep_count`** — counts matching lines before fetching (safety check)
- **`gcs_grep`** — streams and greps a file, with optional time-window filtering and context lines
- **`write_timeline`** — writes the final HTML report to disk

Four skills provide the domain knowledge Claude uses to interpret the logs:

- **`gcs-log-fetcher`** — log file types, rotation conventions, safe fetching protocol
- **`kernel-log-parser`** — syslog line format, subsystem prefixes, uptime tiebreaking
- **`storage-incident-analyzer`** — signal patterns, causal chain, two-pass search strategy
- **`timeline-builder`** — event merging, deduplication, phase grouping, HTML output format
