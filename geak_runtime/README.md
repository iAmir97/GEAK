# GEAK runtime bridge

This directory is the optional Bun runtime used by the OMP harness. Claude-only
users do not install it, and the Python package does not import it on the Claude
path.

```bash
bun install --cwd geak_runtime --frozen-lockfile
```

The OMP package is pinned in `package.json`. Verify the installation without
starting a model session:

```bash
bun geak_runtime/omp_runner.ts --diagnostics
```

`omp_runner.ts` accepts a serialized invocation file containing the repository,
workflow script, workflow arguments, explicit tool allowlist, timeout, model,
thinking level, artifact paths, environment, and run identifier. The workflow
host evaluates the existing GEAK source inside its async wrapper and injects
only `args`, `agent`, `workflow`, `parallel`, `pipeline`, `phase`, and `log`.

Set `GEAK_DEBUG_TIMINGS=1` for opt-in records covering OMP process wall time,
session creation, model completion/first token, tool execution, and schema
validation. Full transcripts remain disabled unless
`GEAK_DEBUG_TRANSCRIPTS=1` is explicitly set.
