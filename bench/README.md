# msg-hub performance benchmarks

Zero-dependency harnesses for the read path, SSE fanout, and browser rendering.
They use temp data directories only; they never read or write the repo's `data/`.

Baseline and after-change numbers are summarized in [`RESULTS.md`](RESULTS.md).

## Run

```bash
# From the repository root (Node 24+).

# Store + HTTP + SSE + send; one process per size.
node --expose-gc bench/server-bench.js \
  --size 10000 --iterations 100 --clients 50 \
  --json bench/results/base-10k.json

# Browser rendering (Chrome/Edge; set MSGHUB_BROWSER if needed).
node bench/ui-bench.js \
  --messages 1000 --steady 50 --burst 200 \
  --json bench/results/ui-base.json
```

Compare after-runs with `--baseline bench/results/base-10k.json` on `server-bench.js`.

## Notes

- `--expose-gc` makes the memory sample meaningful; RSS alone is dominated by V8's retained pages.
- The server benchmark labels cold-store / warm-OS-cache separately. Windows file cache cannot be dropped, so do not read these as cold-disk numbers.
- CPU profiles are a separate run and are not used for latency comparison:
  `--cpu-prof --cpu-prof-dir bench/profiles`.
- The UI benchmark emulates `prefers-reduced-motion: reduce` so scroll checks are deterministic. `--check` is for after-change acceptance; the baseline is allowed to fail the incremental-render marker assertion. The marker is placed on the newest node because appending at the 1000-message cap legitimately evicts the oldest node.
- The burst phase records `longtask` entries; `--check` requires no single long task over 200 ms.
- Benchmark scripts are not part of `npm test` and do not enter the production dependency graph.
