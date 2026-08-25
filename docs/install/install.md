---
myst:
    html_meta:
        "description": "Install GEAK 4.0.0: pip install git+ downloads the repo and selected Claude Code or OMP harness, plus Python deps (ROCm required for GPU workflows)."
        "keywords": "GEAK, install, ROCm, Claude Code, OMP, Workflow, sglang, vLLM, AMD Instinct, setup"
---

# Install GEAK

GEAK 4.0.0 is a Python package plus a set of Workflows (`e2e_workflow.js` / `kernel_workflow.js`). The workflows
run through either Claude Code (the default) or the pinned OMP SDK. "Installing" means: get the repo, select one
harness, and have a working ROCm environment (plus a serving backend for E2E). For a first run, see
[Run a workflow](../how-to/run-agent.md).

## Prerequisites

GEAK 4.0.0 requires the following software and hardware.

| Requirement | Detail |
|---|---|
| **AMD Instinct™ MI GPU** | CDNA, gfx942 (MI300X) / gfx950 (MI350X/MI355X). Auto-detected. |
| **ROCm 6+** | `rocminfo` / `rocm-smi` must work. |
| **A profiler** | One of `rocprof-compute`, `rocprofv3`, `rocprof` (also `omniperf` or `metrix`). Auto-detected. |
| **Python 3.8+** | Tested on 3.12. |
| **Agent harness** | Claude Code ≥ 2.1.177 (default), or Bun ≥ 1.3.14 with OMP SDK 17.4.0. Select with `GEAK_AGENT_HARNESS=omp`. |
| **Provider credentials** | Claude: `ANTHROPIC_API_KEY` or Claude login. OMP: the provider credentials configured for OMP. |
| **Serving backend (E2E)** | A running-capable `sglang` or `vllm`, plus model weights on disk. |

## Set up GEAK

Clone the repository and run the setup script.

Installing GEAK installs the `geak` Python package + deps and clones the GEAK repo. The bootstrap validates only
the selected harness; it does not install the other one.
By default the repo lands in `./GEAK` under the directory you run the command from (override with `GEAK_HOME`).
Pick either method — both end up the same:

**A. One-liner** — run it in the directory where you want GEAK to live:

```bash
pip install "git+https://github.com/AMD-AGI/GEAK"
```

For OMP-only installation, select OMP before running pip (Bun must already be installed):

```bash
GEAK_AGENT_HARNESS=omp pip install "git+https://github.com/AMD-AGI/GEAK"
```

**B. Clone first** — if you'd rather have the checkout up front (e.g. to work on a branch):

```bash
git clone https://github.com/AMD-AGI/GEAK.git
cd GEAK
pip install .
```

It leaves PATH and API access configuration to you. Follow its printed next-steps to add `~/.local/bin` to PATH, then set your Anthropic API key:

```bash
export ANTHROPIC_API_KEY=<your-key>
```

Get a key from [console.anthropic.com](https://console.anthropic.com) if you don't have one. Add the export to your shell profile (`~/.bashrc` or `~/.profile`) to avoid setting it each session.

Launch GEAK with Claude:

```bash
IS_SANDBOX=1 claude --dangerously-skip-permissions
```

Nothing is compiled at clone time — the workflow `.js` files and their `roles/`, `knowledge/`, `scripts/`
are used directly. Sandbox mode auto-approves the permissions the workflows need.

Launch GEAK with OMP:

```bash
GEAK_AGENT_HARNESS=omp bun geak_runtime/omp_runner.ts --diagnostics
GEAK_AGENT_HARNESS=omp python interface/run_e2e.py <handoff.json> <result.json>
```

## Verify the environment

Run these checks before starting a workflow. A misconfigured environment fails deep into a multi-hour run.

```bash
# Claude mode (default)
claude --version

# OMP mode
bun --version
bun geak_runtime/omp_runner.ts --diagnostics

# GPU is visible to ROCm
rocminfo | grep -E "Name:|gfx"

# At least one profiler is on PATH
command -v rocprof-compute || command -v rocprofv3 || command -v rocprof
```

Expected output:

- Claude mode: `claude --version` prints `2.1.177` or higher.
- OMP mode: diagnostics report `detected_version: "17.4.0"` and `status: "available"`.
- `rocminfo` lists your GPU name and a `gfx942` or `gfx950` target.
- At least one profiler command resolves without error.

If `rocminfo` fails, your ROCm stack is not installed or not on PATH. If no profiler resolves, install `rocprof-compute` (preferred) or `rocprofv3`.

## Related topics

- [Run a workflow](../how-to/run-agent.md): start a single-kernel or end-to-end run.
- [Compatibility matrix](../compatibility.md): verified GPUs, ROCm versions, backends, and dtypes.
