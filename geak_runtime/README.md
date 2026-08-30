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

By default GEAK disables OMP extension discovery to keep workflow sessions
isolated. If the selected model is supplied by an OMP extension (for example
the `tokenvisor-pi` TokenVisor provider), load that provider explicitly:

Example:
  GEAK_AGENT_HARNESS=omp GEAK_OMP_MODEL='TokenVisor/Qwen/Qwen3.8-Max' GEAK_OMP_EXTENSION_PATHS='/root/.omp/plugins/node_modules/tokenvisor-pi/extensions/tokenvisor-provider.ts' ./geak_runtime/node_modules/.bin/omp

Use `GEAK_OMP_ENABLE_EXTENSIONS=1` instead when ambient OMP extension discovery
is desired. The explicit path is safer because it loads only the provider
extension needed by GEAK.

GEAK sessions run restricted to the tool allowlist (`restrictToolNames`), which
makes the OMP SDK skip extension loading entirely — including extensions that
register a model provider. An extension-provided model therefore cannot resolve
inside the session and the first prompt fails with `No model selected`. To fix
this, the adapter preloads extension providers into one shared model registry
per harness (the same `loadCliExtensionProviders` path `omp bench` uses) and
hands that registry to every session; subagents inherit it, so one preload
covers the whole workflow run. The preload keeps the tool policy untouched:
only provider registration runs, never extension tools, MCP, or ambient
capabilities. `close()` releases the shared auth storage once all sessions are
disposed.
