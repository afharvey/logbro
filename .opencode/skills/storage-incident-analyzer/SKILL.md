---
name: storage-incident-analyzer
description: Domain knowledge for investigating Azure/AKS storage incidents from kernel logs. Covers the causal chain from Hyper-V VF resets to EXT4 filesystem failure, exact grep patterns for each signal, a two-pass search strategy, and guidance on distinguishing root cause events from downstream noise.
---

## What I do

I provide the domain knowledge to investigate Azure disk attachment failures and EXT4 filesystem incidents on AKS nodes. I define the exact signals to search for, the causal relationships between them, and how to avoid wasting context on repetitive noise.

## The causal chain

This is the failure sequence observed in Azure/AKS storage incidents:

```
Azure Hyper-V host maintenance
  └─ Network VF reset (hv_netvsc)
       └─ PCIe bus release (pci_bus)
            └─ SCSI I/O errors on attached disk (sdX)
                 └─ EXT4 write errors (EXT4-fs warning)
                      └─ EXT4 journal abort (Aborting journal)
                           └─ Filesystem remounted read-only / all ops fail
                                └─ Application errors (Neo4j Raft panic, etc.)
                                     └─ [13+ hours later] Alert detected
```

Understanding this chain tells you which log signals are **root cause** vs **downstream consequence**.

## Two-pass search strategy

### Pass 1 — Discovery (broad, no time filter)

Use this pattern to find the first occurrence of each signal class across the file:

```
EXT4-fs error|Aborting journal|Data path switched from VF|scsi.*Direct-Access|JBD2.*Error|Buffer I/O error on dev
```

This will locate the key timestamps. Call `gcs_grep_count` first, then `gcs_grep`.

### Pass 2 — Context (targeted, time-windowed)

Once Pass 1 reveals the critical timestamps, use `gcs_grep` with `context_lines: 5` and a tight `time_filter` to get the surrounding events for each key moment:

- Around the VF reset (e.g. `time_filter: 'Jan 15 22:28'`)
- Around the first I/O error
- Around the journal abort
- Around the disk reattachment (look for `[sdh]` or the next device letter after the failed one)

## Signal dictionary

These are the exact patterns observed in AKS kernel logs. Use them as grep patterns.

| Signal | grep pattern | Significance | Pass |
|--------|-------------|--------------|------|
| Disk attach | `scsi.*Direct-Access` | New disk enumerated at a LUN | 1 |
| EXT4 mount | `EXT4-fs.*mounted filesystem` | Filesystem successfully online | 1 |
| VF switchover start | `Data path switched from VF` | Azure host maintenance begins — network VF removed | 1 |
| VF slot removed | `VF slot.*removed` | PCIe slot for VF torn down | 2 |
| PCIe bus released | `busn_res.*is released` | PCIe bus reset — can cause collateral SCSI I/O failure | 2 |
| VF slot re-added | `VF slot.*added` | PCIe slot restored — maintenance complete | 2 |
| First I/O error | `EXT4-fs warning.*I/O error 10` | Filesystem write failing — first sign of disk trouble | 1 |
| Buffer I/O error | `Buffer I/O error on dev` | Block layer I/O failure below the filesystem | 1 |
| EXT4 inode failure | `EXT4-fs error.*unable to read itable` | Inode table unreadable — filesystem corruption active | 2 |
| Data loss warning | `This should not happen.*Data will be lost` | EXT4 delayed allocation failure — data loss confirmed | 1 |
| Journal abort | `Aborting journal on device` | Filesystem fenced — this is the point of no return | 1 |
| JBD2 error | `JBD2.*Error.*detected` | Journal superblock update failed — confirms journal abort | 2 |
| Disk reattach | `sd.*\[sd[a-z]\].*4096-byte logical blocks` | Disk reappears — check if device name changed (sdg → sdh) | 1 |
| Repetitive noise | `htree_dirblock_to_tree.*error -5` | Post-abort directory read failures — downstream noise, fires ~every 15s | noise |

## Handling repetitive noise

After the journal abort, `htree_dirblock_to_tree: inode #NNNNNN: error -5` fires approximately every 15 seconds for hours. These are **consequences** of the abort, not new causal events.

Do not ingest hundreds of these lines. Instead:
1. Note the **first occurrence** timestamp
2. Confirm the **frequency** (typically every 15s)
3. Note the **last occurrence** or when it stops (after pod deletion / remount)
4. Summarise as: `(repeated every ~15s until resolution)`

## Disk identity tracking

When Azure reattaches a disk after a VF reset, it may appear under a new device name. Track this by:

1. Find the SCSI address of the original disk (e.g. `scsi 1:0:0:5: [sdg]`)
2. Search for the same SCSI address with a different device name (e.g. `scsi 1:0:0:5: [sdh]`)
3. Note the time gap between the journal abort and the reattachment

The same SCSI address (`1:0:0:N`) = same LUN = same physical disk under a new name.

## Detection gap

The detection gap is the time between:
- **First failure signal**: first `EXT4-fs warning.*I/O error` or `Aborting journal` timestamp in the logs
- **First human awareness**: incident channel creation, alert firing, or first human action in the timeline

Calculate and report this gap explicitly. In Azure disk incidents, this gap is often 10+ hours because:
- `VolumeAttachment` reports `attached: true` even when the mount is dead
- CSI driver logs show no errors
- Only application-level errors (e.g. Neo4j Raft panic) eventually trigger alerts
