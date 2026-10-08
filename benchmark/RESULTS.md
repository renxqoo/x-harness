# Benchmark Results

Run data copied in full from the benchmark workspace; per-task `xharness-stream.jsonl` token traces (~15M/task) were dropped to keep the repo lean. `REPORT-glmf-round1.md` is the original run report, kept as-is.

## round1 (2026-09-27, x-harness CLI headless, glm-5.3-flash, swe3, 21 tasks)

- mean task_score: **80.39** (20 scored + 1 zero — `default-create-in-idp-checkbox-unchecked` produced no artifacts, scored 0)
- by complexity: trivial 87.32 / low 85.40 / medium 83.03 / high 82.36
- tokens (20 tasks with metrics): input 145.6M (cache read 141.2M, 97.0%) / output 1.52M
- median latency 27 min/task (max 53 min)

## turnv2-sample (2026-09-28, same setup, 3-task sample)

- mean 84.53 (87.6 / 83.2 / 82.8) — sample only, not comparable to round1 mean
- `default-create-in-idp-checkbox-unchecked` re-run: still no artifacts, 0
