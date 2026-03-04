---
name: timeline-builder
description: How to merge log events from multiple sources into a structured incident timeline. Covers chronological sorting, uptime-based tiebreaking, deduplication of repetitive messages, phase grouping, and the required HTML output format.
---

## What I do

I teach you how to synthesise grep results from multiple log files into a clean, structured incident timeline in the style of a postmortem document.

## Sorting rules

1. Sort all events by wall-clock timestamp (`Mon DD HH:MM:SS`) ascending
2. For events with the same wall-clock second, use the uptime offset `[NNNNNN.NNNNNN]` to break ties — lower value = earlier
3. If uptime offsets are unavailable (e.g. from different sources), preserve the order they appeared in the log

## Deduplication

Repetitive messages must be collapsed. Do not emit one row per occurrence for high-frequency repeated events.

Rule: if the same message pattern repeats more than 3 times, collapse to:
- First occurrence row (full detail)
- A note in parentheses: `(repeated every ~Xs until <next phase event>)`

Example:
```
| Jan 15 22:28:40 | kern.log.1 | EXT4-fs warning: htree_dirblock_to_tree inode #655361 error -5 (repeated every ~15s until resolution at Jan 16 17:34) |
```

## Phase grouping

Group the timeline into named phases using section headers. Standard phases for a storage incident:

| Phase | Description |
|-------|-------------|
| **Healthy** | Normal operation before any failure signal |
| **VF Reset** | Azure host maintenance event — network VF removed and PCIe bus released |
| **I/O Failure** | First I/O errors through journal abort |
| **Silent Failure** | Post-abort period: filesystem dead, Kubernetes unaware, no alerting |
| **Detection** | First human or automated awareness of the incident |
| **Investigation** | Active debugging period |
| **Resolution** | Corrective action taken and system restored |

Only include phases that have events. If the logs don't cover detection/resolution, omit those phases.

## Output format

Produce a self-contained HTML document. Do not use markdown tables. The HTML must have all CSS inline in a `<style>` block in `<head>` — no external stylesheets or scripts.

### Page structure

```
<html>
  <head>
    <meta charset="utf-8">
    <title>Incident Timeline — [bucket path]</title>
    <style> ... </style>
  </head>
  <body>
    <h1>Incident Timeline</h1>
    <p class="meta">Source: [bucket path] &nbsp;|&nbsp; Generated: [UTC timestamp]</p>

    <!-- One section per phase -->
    <section class="phase phase-healthy">
      <h2>Healthy</h2>
      <table> ... </table>
    </section>

    <!-- Detection gap -->
    <section class="gap">
      <h2>Detection Gap</h2>
      <table> ... </table>
      <p class="gap-reason"> ... </p>
    </section>
  </body>
</html>
```

### CSS to include

```css
body {
  font-family: system-ui, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  max-width: 1100px;
  margin: 2rem auto;
  padding: 0 1rem;
  color: #1a1a1a;
  background: #fff;
}
h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
p.meta { color: #666; font-size: 0.85rem; margin-bottom: 2rem; }
section { margin-bottom: 2rem; }
h2 {
  font-size: 1rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 0.4rem 0.75rem;
  border-radius: 4px;
  margin-bottom: 0.5rem;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}
th {
  text-align: left;
  padding: 0.4rem 0.75rem;
  background: #f5f5f5;
  border-bottom: 2px solid #ddd;
  font-weight: 600;
  white-space: nowrap;
}
td {
  padding: 0.35rem 0.75rem;
  border-bottom: 1px solid #eee;
  vertical-align: top;
}
td.time { white-space: nowrap; color: #555; font-family: monospace; }
td.source { white-space: nowrap; color: #777; font-family: monospace; }
tr:last-child td { border-bottom: none; }

/* Phase header colours */
.phase-healthy h2        { background: #d4edda; color: #155724; }
.phase-vf-reset h2       { background: #fff3cd; color: #856404; }
.phase-io-failure h2     { background: #f8d7da; color: #721c24; }
.phase-silent-failure h2 { background: #f8d7da; color: #721c24; }
.phase-detection h2      { background: #d1ecf1; color: #0c5460; }
.phase-resolution h2     { background: #d4edda; color: #155724; }

/* Detection gap box */
section.gap { background: #fff8e1; border: 1px solid #ffe082; border-radius: 6px; padding: 1rem 1.25rem; }
section.gap h2 { background: none; color: #5d4037; padding: 0; margin-bottom: 0.75rem; }
p.gap-reason { margin-top: 0.75rem; color: #444; }
```

### Phase CSS classes

| Phase | Section class |
|-------|--------------|
| Healthy | `phase phase-healthy` |
| VF Reset | `phase phase-vf-reset` |
| I/O Failure | `phase phase-io-failure` |
| Silent Failure | `phase phase-silent-failure` |
| Detection | `phase phase-detection` |
| Investigation | `phase phase-detection` |
| Resolution | `phase phase-resolution` |

### Table structure per phase

Each phase table has three columns: Time (UTC), Source, Event.

```html
<table>
  <thead>
    <tr><th>Time (UTC)</th><th>Source</th><th>Event</th></tr>
  </thead>
  <tbody>
    <tr>
      <td class="time">Jan 15 22:26:41</td>
      <td class="source">kern.log.1</td>
      <td>Disk attached as /dev/sdg (LUN 5, 64GB)</td>
    </tr>
  </tbody>
</table>
```

## Detection gap summary

Render the detection gap as a `<section class="gap">` containing a two-row table and a plain-text explanation paragraph:

```html
<section class="gap">
  <h2>Detection Gap</h2>
  <table>
    <tbody>
      <tr><td class="time">Jan 15 22:28:30</td><td>First failure signal in logs</td></tr>
      <tr><td class="time">Jan 16 12:00</td><td>First human awareness</td></tr>
      <tr><td class="time"><strong>~13.5 hours</strong></td><td><strong>Total gap</strong></td></tr>
    </tbody>
  </table>
  <p class="gap-reason">
    VolumeAttachment reported <code>attached: true</code> throughout. CSI driver logs showed
    no errors. Detection relied on Neo4j application-level Raft panic alert.
  </p>
</section>
```

## Source attribution

Always include the source file in the `Source` column. Use the filename only (not the full GCS path):
- `kern.log.1` not `gs://bucket/path/kern.log.1`
- If multiple files contributed to a single event (e.g. corroborated in both kern.log.1 and syslog.1), note the primary source

## What to omit

- Routine events with no bearing on the incident (e.g. IPv6 address configuration, unrelated cgroup messages)
- Individual repetitions of high-frequency noise (collapse per deduplication rule above)
- Verbose multi-line kernel stack traces — summarise as a single row with the key error message
