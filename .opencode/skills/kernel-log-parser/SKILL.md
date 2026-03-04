---
name: kernel-log-parser
description: How to read and interpret Linux kernel log files (kern.log, dmesg, syslog). Covers timestamp formats, line structure, subsystem prefixes, and how to use uptime offsets as tiebreakers for precise event ordering.
---

## What I do

I teach you how to parse and interpret Linux kernel log lines, so you can extract precise event sequences from raw log output.

## kern.log / syslog line format

Every line follows this structure:

```
Mon DD HH:MM:SS <hostname> kernel: [<uptime.usec>] <subsystem> <message>
```

Example:
```
Jan 15 22:28:30 aks-dmv5skbo-94141891-vmss00000Q kernel: [2628930.237814] EXT4-fs (sdg): This should not happen!! Data will be lost
```

| Field | Example | Notes |
|-------|---------|-------|
| Timestamp | `Jan 15 22:28:30` | Wall-clock time, no year, UTC on AKS nodes |
| Hostname | `aks-dmv5skbo-94141891-vmss00000Q` | AKS node name — case may vary |
| Source | `kernel:` | Always `kernel:` for kernel messages |
| Uptime offset | `[2628930.237814]` | Seconds.microseconds since boot — use as tiebreaker |
| Subsystem | `EXT4-fs (sdg)` | Identifies the kernel component |
| Message | `This should not happen!!...` | Free-form event description |

## dmesg format

`dmesg` output has **no wall-clock timestamp** — only the uptime offset:

```
[2628930.237814] kernel: EXT4-fs (sdg): This should not happen!! Data will be lost
```

To correlate dmesg with kern.log events, match the uptime offset `[NNNNNN.NNNNNN]` values.

## Using the uptime offset as a tiebreaker

When multiple events share the same wall-clock second (common during rapid failure cascades), sort by the uptime offset to establish the precise order. The offset is monotonically increasing and has microsecond resolution.

Example — two events at `22:28:30`, ordered by uptime:
```
[2628929.881160] Data path switched to VF: enP64055s1     ← earlier
[2628930.194532] I/O error 10 writing to inode 524369     ← later (309ms after)
```

## Key kernel subsystems for storage investigation

| Subsystem prefix | What it reports |
|-----------------|-----------------|
| `EXT4-fs (sdX)` | Filesystem-level events: mount, errors, journal abort, data loss |
| `JBD2` | EXT4 journal block device — journal superblock errors, abort confirmation |
| `sd N:N:N:N: [sdX]` | SCSI disk enumeration — disk attach, device name, size, LUN |
| `scsi N:N:N:N:` | SCSI layer events — device discovery and removal |
| `hv_netvsc ... eth0:` | Hyper-V network virtual function — VF switchover, slot add/remove |
| `hv_pci` | Hyper-V PCIe pass-through — PCI bus events during VF reset |
| `pci_bus XXXX:00:` | PCIe bus resource management — bus release and re-acquisition |
| `hv_utils` | Hyper-V utilities (heartbeat, KVP, shutdown, timesync) — indicates host maintenance |
| `hv_balloon` | Hyper-V memory balloon — often accompanies host maintenance events |
| `Buffer I/O error` | Block layer I/O failure — device-level errors below the filesystem |

## Pattern notes

- Device names in log lines appear as `sdg`, `sdh`, etc. — always lowercase in kernel messages
- LUN is identified by the last digit in the SCSI address: `scsi 1:0:0:5` = LUN 5
- The same physical disk reattaching under a new device name will have the **same SCSI address** (`1:0:0:5`) but a different device name (`[sdg]` → `[sdh]`)
- `EXT4-fs error` (no `warning`) is more severe than `EXT4-fs warning` — errors indicate active filesystem corruption
