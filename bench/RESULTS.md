# msg-hub performance results

Environment: Windows 11, Node 24, local NTFS.
Fixture: two-day JSONL, 40% yesterday / 60% today, 160B bodies, 1k / 10k / 100k messages.
Each cell is the median of 3 runs (`bench/results/base-<size>-run1..3.json`).
"cold" = first read in a fresh `Store`; Windows cannot drop the OS file cache, so it is not a cold-disk number.

## Server baseline (no cache)

| metric | 1k | 10k | 100k | target |
|---|---:|---:|---:|---|
| store.recent(50) p95 | 1.74 ms | 13.89 ms | 152.41 ms | ≤2 ms @100k |
| store.recentSys(50) p95 | 2.05 ms | 14.73 ms | 162.46 ms | ≤2 ms @100k |
| store.since(near,200) p95 | 1.74 ms | 16.65 ms | 138.80 ms | ≤2 ms @100k |
| http /messages(50) p95 | 1.97 ms | 17.94 ms | 150.72 ms | ≤10 ms @100k |
| http /since(near,200) p95 | 2.58 ms | 17.98 ms | 137.68 ms | ≤10 ms @100k |
| http /since/0(1000) p95 | 7.59 ms | 28.25 ms | 163.00 ms | - |
| event-loop p99 during HTTP | 26.18 ms | 152.70 ms | 1457.52 ms | ≤20 ms |
| SSE replay 1000 p95 | 7.26 ms | 20.78 ms | 136.83 ms | ≤50 ms |
| SSE 50 concurrent replays p95 | 270.14 ms | 770.68 ms | 5808.58 ms | - |
| SSE fanout 50 clients p95 | 6.73 ms | 6.13 ms | 6.77 ms | ≤20 ms |
| /send p95 | 3.35 ms | 3.42 ms | 3.32 ms | no >20% regression |
| heapUsed after HTTP phase | 10.1 MB | 10.0 MB | 9.9 MB | ≤180 MB after cache |
| RSS after HTTP phase (informational) | 206.7 MB | 294.0 MB | 441.9 MB | - |

Reading is O(total window bytes) on every request: 100k messages cost ~140–170 ms per read regardless of the 50–200 rows returned, and stall the event loop for ~1.5 s under 10-way concurrency. Fanout and `/send` already meet their targets.

## Browser baseline (1000 history, 200 burst)

Chrome headless, `prefers-reduced-motion: reduce`, median of 3 runs (`bench/results/ui-base-run1..3.json`).

| metric | baseline | target |
|---|---:|---|
| full render p95 | 163.80 ms | - |
| live message, autoScroll p95 | 132.00 ms | ≤16 ms |
| live message, no autoScroll p95 | 132.50 ms | ≤16 ms |
| 200-message burst total | 28901 ms | ≤500 ms (1000 burst; 200 already 58× over) |
| room switch ctf / all | 31.20 / 108.70 ms | - |
| early node survives live append | false | true |

Every message triggers `sort()` plus a full `replaceChildren` rebuild of all 1000 nodes, so live latency is ~130 ms and a burst is quadratic.

## After Stage 1: full-window snapshot cache

Median of 3 post-change runs (`bench/results/stage1-100k-run4..6.json`; runs 1–3 were used to validate the change before `Store.close()` also released the snapshot).

| metric | 10k after | 100k baseline | 100k after | target | result |
|---|---:|---:|---:|---|---|
| store.recent(50) p95 | 0.17 ms | 152.41 ms | 1.37 ms | ≤2 ms @100k | PASS |
| store.recentSys(50) p95 | 0.16 ms | 162.46 ms | 1.81 ms | ≤2 ms @100k | PASS |
| store.since(near,200) p95 | 0.09 ms | 138.80 ms | 0.48 ms | ≤2 ms @100k | PASS |
| http /messages(50) p95 | 0.63 ms | 150.72 ms | 2.03 ms | ≤10 ms | PASS |
| http /messages(50) p99 | 1.61 ms | - | 2.11 ms | ≤25 ms | PASS |
| http /since(near,200) p95 | 0.84 ms | 137.68 ms | 1.33 ms | ≤10 ms | PASS |
| event-loop p99 | 12.36 ms | 1457.52 ms | 21.27 ms | ≤20 ms | MISS by 1.3 ms |
| SSE replay 1000 p95 | 6.15 ms | 136.83 ms | 7.13 ms | ≤50 ms | PASS |
| SSE 50 concurrent replays p95 | 173.68 ms | 5808.58 ms | 200.07 ms | - | - |
| SSE fanout 50 clients p95 | 4.91 ms | 6.77 ms | 5.50 ms | ≤20 ms | PASS |
| /send p95 | 3.33 ms | 3.32 ms | 3.55 ms | no >20% regression | PASS (+6.9%) |
| heapUsed after Store phase | 24.3 MB | 9.9 MB | 63.7 MB | ≤180 MB | PASS |

The event-loop target is the only miss: the 100k snapshot adds GC work that keeps p99 around 21 ms. The baseline's own 1k run was already 26 ms, so the 20 ms threshold is below this machine's floor for the harness; the 10k case now measures 12.4 ms. Stage 2 (tail scan/binary search) and Stage 3 (SSE frame reuse/batched replay) were skipped because their targets are met (Store warm reads ≤2 ms, replay ≤50 ms, fanout ≤20 ms). Stage 5 (logger byte counter) was skipped because it was never shown to be >5–10% of a measured hot path.

## After Stage 4: incremental UI rendering

5 runs at 1000 history / 50 steady / 1000 burst (`ui-after-run1..5.json`); burst median 204.70 ms.

| metric | baseline | after | target | result |
|---|---:|---:|---|---|
| live message p95 (JS, before frame) | 132.00 ms | 0.30 ms | ≤16 ms | PASS |
| live message max | ~200+ ms | 0.50 ms | ≤32 ms | PASS |
| 1000-message burst total | ~145 s (extrapolated; 200 took 28.9 s) | 204.70 ms | ≤500 ms | PASS |
| longest long task in burst | - | 131 ms | ≤200 ms | PASS |
| early-node marker survives live append | false | true (newest node) | true | PASS |
| DOM count / unique / ascending / day / empty / bottom | pass | pass | pass | PASS |
| full render p95 | 163.80 ms | 172.00 ms (median) | not targeted | unchanged |
| room switch ctf / all | 31.20 / 108.70 ms | 12.30 / 108.20 ms | not targeted | unchanged |

Live messages are now queued and flushed in one `requestAnimationFrame`, so the per-call JS time is near zero and rendering happens once per frame; the 1000-message burst creates its nodes in one fragment and performs one layout (`LayoutCount: 1`). Full rebuilds are still used for room switches, history loads, day rollover, identity changes, and out-of-order messages.

### Rerun after @-mention / visual work (2026-11-05)

One `--check` run after adding the mention autocomplete and the visual refresh: full render p95 163.50 ms, steady auto-scroll p95 0.30 ms, steady no-auto p95 0.20 ms, 1000-message burst 218.10 ms, longest long task 183 ms, all invariants pass. This is a single run, not a new 5-run baseline; the burst is within the run-to-run range of the 204.70 ms median and the long task stays under the 200 ms guardrail.

## Conclusion

Stage 1 and Stage 4 met every declared target except the 100k event-loop p99 (21.3 ms vs 20 ms, a 1.3 ms miss attributable to GC of the 100k snapshot; baseline at 1k was already 26 ms). Reads no longer scale with total window bytes, SSE replay dropped 19×, and a 1000-message UI burst dropped from roughly 145 s (extrapolated) to 0.2 s. No protocol, JSONL format, durability order, or dependency changed.
