# Local Kiro QA evidence

QA drivers default to the checkout parent's `.qa/kiro/` directory. Each run
allocates a private, unique child (`kiro-package-*`, `kiro-live-*`, or
`kiro-offline.*`). No username or system temporary path is hardcoded.

`KIRO_QA_ARTIFACTS` overrides the **parent artifact base** for isolated tests.
It is separate from `KIRO_QA_ROOT`, which remains the package fake CLI's
**individual run root**. Ambient `TMPDIR` does not select the artifact base;
fixtures explicitly pass `KIRO_QA_ARTIFACTS` and continue to supply `TMPDIR`
for runtime scratch. The offline runner passes its unique root to child
fixtures and removes only that root on exit. Standalone package/live drivers
retain evidence while preserving their existing owned-resource cleanup.

## Preserved acceptance evidence

These are byte-for-byte historical copies, not new acceptance runs. Recorded
paths inside the files remain unchanged for provenance. Evidence directories
are private (`0700`), files are private (`0600`); do not edit or overwrite them.
Original evidence remains at the source locations below.

| Local copy | Copied files | Original source directory |
| --- | --- | --- |
| [kiro-live-zGo9Of](../.qa/kiro/evidence/kiro-live-zGo9Of/) | `evidence.json`, `trace.jsonl`, `prompt-1`, `prompt-2` | Original macOS temp location, `kiro-live-zGo9Of` |
| [kiro-package-9rVoJE](../.qa/kiro/evidence/kiro-package-9rVoJE/) | `evidence.json`, `events.json`, `trace.jsonl`, `host.log` | Original macOS temp location, `kiro-package-9rVoJE` |
| [kiro-acceptance-iEddgS](../.qa/kiro/evidence/kiro-acceptance-iEddgS/) | `offline.log`, `native.log`, `summary.json` | Original macOS temp location, `kiro-acceptance-iEddgS` |
