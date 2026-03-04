---
name: gcs-log-fetcher
description: How to discover and selectively fetch Linux system log files from a GCS bucket using the gcs_list, gcs_grep_count, and gcs_grep tools. Covers log file types, rotation conventions, and a size-safe fetching strategy.
---

## What I do

I teach you how to navigate and selectively read Linux system logs stored in a GCS bucket, without ever fetching an entire file.

## Log file types

These are the standard log files you will encounter in an AKS/Linux node log dump:

| File | Contents |
|------|----------|
| `kern.log` / `kern.log.N` | Kernel messages only — the most important source for storage and hardware events |
| `dmesg` / `dmesg.0` | Kernel ring buffer snapshots — useful for boot-time and hardware enumeration events. No wall-clock timestamps, only uptime offsets. |
| `syslog` / `syslog.N` | All system log messages including kernel, systemd, and application logs. Very large. |
| `messages` / `messages.N` | Similar to syslog on Debian/Ubuntu systems — often a near-duplicate. |
| `warn` / `warn.N` | Warnings and above only — a filtered subset of syslog. |

For storage incident investigation, prioritise in this order:
1. `kern.log.1` — kernel messages from the previous rotation period (most likely to contain the incident)
2. `kern.log` — current kernel messages (aftermath of the incident)
3. `warn.1` / `warn` — if you need a quick scan for high-severity events across all subsystems
4. `syslog.1` — only if kernel logs are insufficient; it is very large (up to 20MB uncompressed)

## Log rotation convention

| Suffix | Meaning |
|--------|---------|
| No suffix (e.g. `kern.log`) | Current file — actively written, covers most recent period |
| `.1` (e.g. `kern.log.1`) | Previous rotation — covers the period before the current file |
| `.2.gz`, `.3.gz`, … | Older rotations, compressed — only needed for incidents more than ~2 days old |

Rotation typically happens at midnight. If an incident occurred yesterday, `kern.log.1` is your primary source.

## Mandatory fetching protocol

**Never call `gcs_grep` without first calling `gcs_grep_count`.**

Follow this sequence for every file and pattern:

1. **`gcs_list`** — list the bucket path to see all available files and their sizes. Do this once at the start of an investigation.

2. **`gcs_grep_count`** — count matching lines before fetching. If the count exceeds the safe threshold (200 lines):
   - Narrow the pattern (make it more specific)
   - Add or tighten the `time_filter` (e.g. `'Jan 15 22:2'` instead of `'Jan 15'`)
   - Repeat `gcs_grep_count` until the count is safe

3. **`gcs_grep`** — fetch only when the count is confirmed safe. Use `context_lines: 5` when you want to understand the surrounding events for a specific signal.

## Decompression

The tools handle `.gz` files automatically. Pass the full GCS URI including the `.gz` suffix — the tool will decompress the stream before grepping.

## Time filter format

Log lines use syslog timestamp format: `Mon DD HH:MM:SS`

Use a prefix string as the `time_filter` to narrow to a time window:
- `'Jan 15 22:'` — all of 22:xx on Jan 15
- `'Jan 15 22:2'` — 22:20–22:29 on Jan 15
- `'Jan 15 22:28'` — only 22:28 on Jan 15

The time filter is applied as a fixed-string pre-filter before the pattern grep.
