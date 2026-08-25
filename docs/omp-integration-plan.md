# OMP integration plan

## 1. Objective

Add support for [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi) as an alternative agent harness while keeping the existing Claude Code path fully supported.

The integration should preserve the properties that make GEAK effective:

- deterministic JavaScript workflow control flow;
- GEAK-owned retries, timeouts, parallelism, and GPU locking;
- the current benchmark, server, measurement, validation, and artifact contracts;
- structured outputs from judgement agents;
- the current `interface/run_e2e.py` handoff and terminal-marker behavior;
- no additional model-planning layer or unnecessary context injected into each agent call.

The intended result is a selectable harness boundary:

```text
                         +----------------------+
                         | GEAK workflow scripts |
                         | kernel / e2e workflow |
                         +----------+-----------+
                                    |
                         harness-neutral runtime
                                    |
                    +---------------+---------------+
                    |                               |
          Claude Code adapter                 OMP adapter
          current behavior                    OMP SDK session
                    |                               |
             Claude Code Workflow                    OMP
```

The central design decision is to use OMP as the implementation of GEAK's agent primitive, not as a second orchestrator around GEAK. GEAK should continue to own workflow scheduling and benchmark execution.

## 2. Current coupling to Claude Code

GEAK is not merely invoking a command-line model. Its JavaScript files are written as Claude Code Workflow programs. The important coupling points are:

| Area | Current assumption | Integration implication |
| --- | --- | --- |
| Workflow execution | `kernel_workflow/*.js` and `e2e_workflow/*.js` rely on injected globals such as `args`, `agent`, `workflow`, `parallel`, `pipeline`, `phase`, and `log`. | A replacement must provide the same runtime contract or the workflow files must be rewritten. The compatibility layer is safer. |
| JavaScript wrapper | Workflow scripts contain top-level `return`; the Claude Workflow runtime wraps the script body in an async function. | They cannot initially be executed as ordinary Node modules. The new host needs an equivalent wrapper or a later source refactor. |
| Agent call | `kernel_lane.js` calls the injected `agent()` function, including schema-constrained calls and retry/timeout handling. | OMP must implement this function with equivalent result and failure semantics. |
| Structured judgement | Role agents request structured JSON and validate decisions before the workflow continues. | OMP output must be schema-constrained and parsed into the same object shape. Free-form text is not a compatible fallback. |
| Nested workflow calls | The runtime supports a specific nesting model; e2e comments explicitly avoid unsupported deeper nesting. | Do not replace GEAK's nesting with OMP task nesting. Preserve the existing depth and scheduling rules. |
| Permissions | The current launch path uses Claude-specific bypass/auto-approved permissions and enables Claude Workflows/Ultracode. | OMP needs an explicitly scoped, non-interactive approval policy for the tools GEAK actually uses. |
| External entry point | `interface/run_e2e.py` invokes Claude through the Python SDK when available and falls back to the Claude CLI. | Keep the result/terminal-marker contract stable and hide harness selection behind the invocation layer. |
| Installation | Bootstrap and documentation install and validate the Claude CLI. | Make Claude and OMP optional, selectable dependencies; do not make both mandatory for users who only need one. |

The key limitation is therefore the runtime contract, not the model provider. GEAK's workflow source assumes that a Claude Code host will compile/evaluate it inside a special async wrapper and inject the workflow primitives. OMP can supply agent sessions and tools, but it does not automatically execute GEAK's Claude Workflow source with those globals.

Relevant repository references:

- [README.md](../README.md)
- [Claude compatibility requirements](compatibility.md)
- [kernel workflow runtime](../kernel_workflow/kernel_workflow.js)
- [kernel lane agent boundary](../kernel_workflow/kernel_lane.js)
- [e2e workflow](../e2e_workflow/e2e_workflow.js)
- [runtime test-mode dispatcher](../kernel_workflow/scripts/test_mode_dispatch.js)
- [external runner contract](reference/run-e2e-contract.md)
- [external runner implementation](../interface/run_e2e.py)

## 3. Recommended architecture

### 3.1 Add a small harness-neutral runtime boundary

Introduce a runtime package, preferably TypeScript/Bun-compatible because the OMP SDK is TypeScript-based. It should define the contracts used by GEAK and contain the workflow host and harness adapters.

Proposed layout:

```text
geak_runtime/
  types.ts                 # request/result/error contracts
  harness.ts               # AgentHarness interface and selection
  workflow_host.ts         # async wrapper and injected globals
  workflow_primitives.ts   # workflow/parallel/pipeline/phase/log bindings
  claude_harness.ts        # compatibility adapter, if/when converged
  omp_harness.ts           # OMP SDK adapter
  omp_runner.ts            # process entry point for Python/CI/UI callers
  web_fetch.ts             # explicit fetch implementation if needed

.omp/extensions/
  geak.ts                  # thin OMP command/tool integration

interface/
  run_e2e.py               # stable public contract; harness selection only
```

Names may be adjusted to match the repository's package conventions. The important separation is:

1. workflow hosting;
2. agent-harness integration;
3. user-interface or process-launch integration.

The first implementation can leave Claude's current path untouched and add an OMP-specific runner. Once the contract tests pass, the Claude path can be moved behind the same interface. This reduces migration risk and avoids a large simultaneous rewrite.

### 3.2 Define the agent contract around GEAK's needs

The interface should be intentionally smaller than either Claude Code or OMP. A representative shape is:

```ts
type AgentRequest = {
  prompt: string;
  cwd: string;
  tools?: string[];
  outputSchema?: unknown;
  outputSchemaMode?: "strict" | "loose";
  model?: string;
  thinking?: string;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
};

type AgentResult<T = unknown> = {
  data: T;                 // parsed structured result when a schema was requested
  text?: string;           // optional diagnostic/raw response
  usage?: Record<string, unknown>;
  provider: "claude" | "omp";
};

interface AgentHarness {
  run<T>(request: AgentRequest): Promise<AgentResult<T>>;
  close?(): Promise<void>;
}
```

The contract must also define failure categories, rather than passing provider-specific exceptions through workflow code:

- `AgentTimeoutError`: the call exceeded its deadline;
- `AgentAbortError`: the workflow or parent was cancelled;
- `AgentPermissionError`: a required tool was not permitted;
- `AgentStructuredOutputError`: output did not satisfy the requested schema;
- `AgentTransportError`: SDK/CLI/session communication failed;
- `AgentUnavailableError`: the selected harness is not installed or configured.

The existing retry policy in `kernel_lane.js` remains the source of truth. The adapter reports failures; it must not independently retry and accidentally multiply attempts.

### 3.3 Host existing workflow source before rewriting it

Phase 1 should provide a `WorkflowHost` that:

1. reads the workflow source;
2. wraps it in the same kind of async function expected by the current scripts;
3. injects the globals that the script expects;
4. evaluates it in a controlled scope;
5. returns the workflow's final value and normalized errors.

The injected bindings should initially cover the existing runtime surface:

```text
args, agent, workflow, parallel, pipeline, phase, log
```

The host must preserve the current behavior of:

- `workflow({ scriptPath, args })` dispatch;
- one-level nested workflow semantics;
- `parallel()` and `pipeline()` ordering and error propagation;
- phase/status logging;
- top-level return values;
- cancellation and timeout propagation;
- current working directory and environment handling.

Do not rewrite `kernel_workflow.js`, `kernel_lane.js`, or `e2e_workflow.js` into provider-specific code. Once the host contract is stable, a later cleanup may convert scripts into explicit `async function run(ctx) {}` modules. That is a separate refactor and should not be required for the first OMP release.

If the source-wrapper approach proves too fragile under Bun, introduce a narrowly scoped compatibility transform or a generated wrapper file. Do not use an unrestricted `eval` surface: constrain the evaluation context, validate the script path against the repository, and inherit only the environment variables required by the current runner.

## 4. OMP adapter design

### 4.1 Use the OMP SDK for child agent calls

Use OMP's embedded SDK/session API for calls made by GEAK's `agent()` primitive. OMP documents `createAgentSession`, in-memory sessions, tool restrictions, and structured output configuration in its [SDK documentation](https://github.com/can1357/oh-my-pi/blob/main/docs/sdk.md).

This is preferable to launching `omp` as a new CLI process for every role-agent call because it avoids repeated process startup, duplicated prompt/context setup, and an extra text protocol that would have to be parsed. OMP's ACP mode is useful for editor/client integration, but it is not the lowest-overhead internal boundary for high-frequency GEAK child calls.

For each GEAK `agent()` request, the adapter should:

1. create or obtain an in-memory OMP session;
2. use the GEAK-provided `cwd`;
3. pass the prompt unchanged except for the minimum provider-required envelope;
4. restrict the available OMP tools to the requested GEAK tool set;
5. pass through the requested model and thinking/effort configuration;
6. pass the JSON schema through OMP's structured-output option;
7. await the final structured result;
8. validate/normalize the result at the adapter boundary;
9. return the same data shape expected by `kernel_lane.js`;
10. abort the session on timeout or parent cancellation.

Do not enable all OMP skills, MCP servers, LSP integrations, or extensions for every child call by default. They add startup/context/tool-selection overhead and create behavior that is not present in the Claude path. Add them only as an explicit GEAK capability.

### 4.2 Tool mapping

Keep tool names in the GEAK layer provider-neutral and map them inside the adapter:

| GEAK capability | Claude Code mapping | OMP mapping | Notes |
| --- | --- | --- | --- |
| shell command | `Bash` | `bash` | Preserve cwd, environment, timeout, and output capture. |
| read file | `Read` | `read` | Preserve path restrictions and encoding behavior. |
| write file | `Write` | `write` | Preserve repository scope and failure behavior. |
| edit file | provider-specific/current tool set | `edit` | Add only where current GEAK prompts require it. |
| search files | provider-specific/current tool set | `grep` / `glob` | Prefer the smallest tool set needed by the prompt. |
| web discovery | `WebSearch` | `web_search` | Discovery of relevant sources. |
| known-page retrieval | `WebFetch` | custom GEAK fetch tool | OMP's standard CLI help exposes `web_search`; do not silently substitute search for fetch. |
| nested agent work | GEAK workflow/agent boundary | optional OMP `task` | Not the primary scheduler; see section 5. |

`web_search` and `web_fetch` must remain distinct. Search finds candidate sources; fetch retrieves and reads a known URL. If DRA or another workflow needs both, expose two explicit capabilities. Implement `web_fetch` as a small GEAK-owned tool or OMP extension with URL validation, size limits, timeout, content-type handling, and clear failure reporting. OMP's [extension model](https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md) is suitable for registering such a tool.

### 4.3 Structured outputs

Structured output is a compatibility requirement, not an optimization. The adapter should use OMP's `outputSchema` support where available, with strict mode for role-agent decisions. It must:

- reject malformed JSON;
- validate required properties and types;
- reject extra fields if the GEAK schema is strict;
- retain the raw response in diagnostics without using it as the workflow result;
- classify schema failures so the existing retry loop can handle them;
- include the schema hash and harness/model in debug logs for reproducibility.

Do not make every agent call structured if the existing call is intentionally free-form. Match the current call site: schema-constrained calls remain constrained, and free-form calls remain text-oriented.

### 4.4 Sessions and lifecycle

Start with an in-memory session per logical agent request or per workflow lane, depending on the measured SDK startup cost and state-isolation requirements. The default should favor isolation: a role agent must not inherit hidden conversation history from another role or benchmark case.

If profiling shows session creation is material, reuse a process-level OMP runtime while creating isolated conversation/session state per request. Reuse must not share transcript, tool state, approval state, or working-directory state across lanes.

On every workflow termination path:

- abort active OMP requests;
- wait for child cleanup up to a bounded grace period;
- close the OMP session/runtime;
- preserve the existing terminal marker and artifact behavior;
- return the original GEAK exit status.

## 5. Preserve GEAK ownership of orchestration

The cleanest performance-preserving boundary is:

```text
GEAK owns: workflow graph, retries, parallelism, pipeline order,
           GPU semaphores, benchmark/server lifecycle, validation,
           artifact/result contracts.

OMP owns: one model session, its allowed tools, model reasoning,
          OMP-native structured output, and optional OMP UI integration.
```

Do not make an OMP parent agent interpret the full GEAK workflow. That would add another planning layer, alter prompt/context allocation, make concurrency less deterministic, and risk duplicate scheduling.

Do not replace GEAK's `parallel()` with OMP's `task.batch`. OMP task supports batching, bounded concurrency, asynchronous execution, and structured outputs as documented [here](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/task.md), but GEAK's scheduler also coordinates GPU locks, benchmark occupancy, server lifecycles, and measurement boundaries. OMP task can be offered as an optional tool inside an individual OMP session, but it must not be the implementation of GEAK's top-level parallelism.

The same rule applies to worktrees: do not enable OMP worktree isolation for GEAK lanes unless a workflow explicitly requests it. GEAK currently controls the repository and benchmark working directories.

## 6. OMP user-facing integration

Add a thin OMP extension/command that exposes GEAK without duplicating the orchestration implementation. A first version could provide one command or tool such as:

```text
/geak <workflow-or-recipe> [options]
```

The extension should:

- validate the requested workflow/recipe;
- invoke the shared `WorkflowHost`/runner;
- stream concise phase and terminal status;
- link or print the same artifacts produced by the existing runner;
- propagate cancellation;
- return the same success/failure status as the external runner.

It should not contain kernel optimization policy, benchmark logic, GPU locking, retry policy, or a second result parser. The extension is a frontend only.

For editor/client integrations, OMP's ACP mode can be documented as an optional transport. It should call the same runner and not become a third implementation of workflow execution. OMP's README describes ACP and SDK/embedding options: [OMP README](https://github.com/can1357/oh-my-pi/blob/main/README.md).

## 7. Python and CI integration

Keep `interface/run_e2e.py` as the stable external contract described in [run-e2e-contract.md](reference/run-e2e-contract.md). Refactor only the harness-specific launch code:

```text
GEAK_AGENT_HARNESS=claude   # current default
GEAK_AGENT_HARNESS=omp      # new path
```

Recommended first implementation:

1. Leave Claude SDK/CLI selection and its existing background-task handling intact.
2. Add a small OMP runner entry point, launched with the repository's supported Bun runtime.
3. Make the Python runner select the OMP entry point when `GEAK_AGENT_HARNESS=omp`.
4. Have both paths report the same terminal marker, exit code, result file, logs, and failure classification.
5. Keep all benchmark commands and server process handling in Python/GEAK, not in OMP.

The OMP runner must receive an explicit serialized invocation object containing at least:

- repository/workspace path;
- workflow script or recipe;
- workflow arguments;
- model and thinking configuration;
- timeout/deadline;
- allowed tools;
- output/artifact paths;
- environment variables required by the benchmark;
- run identifier for logs and cleanup.

Avoid relying on the caller's interactive OMP configuration for CI behavior. Interactive configuration can be used by the OMP UI frontend, but reproducible runs need explicit settings.

## 8. Configuration and dependency policy

Add a single harness configuration source with clear precedence:

1. explicit CLI/Python argument;
2. `GEAK_AGENT_HARNESS` environment variable;
3. repository configuration;
4. default `claude` for backward compatibility.

Add OMP-specific configuration only under an OMP namespace, for example:

```text
GEAK_AGENT_HARNESS=omp
GEAK_OMP_COMMAND=omp                 # optional CLI/diagnostic command
GEAK_OMP_MODEL=<explicit model>
GEAK_OMP_THINKING=<explicit level>
GEAK_OMP_ALLOWED_TOOLS=bash,read,write,grep,glob,web_search
GEAK_OMP_ENABLE_MCP=0
GEAK_OMP_ENABLE_LSP=0
GEAK_OMP_ENABLE_EXTENSIONS=0
GEAK_OMP_EXTENSION_PATHS=<optional provider extension paths>
```

Do not silently translate a Claude model name into a different OMP model. If no model is configured, fail with a clear message or use a documented OMP default. For performance comparisons, pin the same underlying model and thinking/effort level where both harnesses can use them.

The installation flow should detect the selected harness:

- Claude mode checks the current Claude version and Workflow capability.
- OMP mode checks Bun and the pinned OMP package/version.
- `all`/developer mode may check both.

Do not force OMP installation on Claude-only users or force Claude installation on OMP-only users. Update README, compatibility docs, install docs, and `pyproject.toml` descriptions so they no longer imply that Claude is the only supported harness.

Pin or otherwise constrain the OMP version in the chosen package-management path. OMP APIs such as session creation, tool restriction, and structured output are integration surfaces that can change; startup should report the detected version.

## 9. Performance-preservation requirements

“Without affecting performance” has two meanings here:

1. **Measured kernel/serving performance:** OMP must not change the benchmark executable, server, GPU lock, measurement window, warmup, or acceptance logic. This is controllable and should remain identical.
2. **Optimization quality and wall-clock search time:** changing the harness can alter model behavior, tool latency, context, and decision quality. This cannot be assumed identical and must be measured.

The implementation must enforce the following:

- no OMP parent-agent planning layer;
- no duplicate GEAK/OMP scheduler;
- no extra system prompt, skills, MCP servers, LSP indexing, or worktree setup by default;
- same prompt text and schema at the GEAK boundary;
- same model family and explicit thinking/effort settings for A/B comparisons;
- in-memory sessions and a long-lived OMP runtime where profiling supports it;
- OMP tool allowlists rather than all-tool discovery;
- GEAK-owned retries, deadlines, and concurrency;
- no logging of full transcripts on the hot path unless debug mode is enabled;
- bounded stdout/stderr capture and streaming backpressure;
- no network fetches performed by the host unless a workflow explicitly requests them.

Record timing separately for:

- OMP process/runtime startup;
- session creation;
- model time-to-first-token and completion;
- tool execution time;
- schema validation;
- GEAK scheduling wait time;
- benchmark/server execution time.

This makes it possible to tell whether an apparent regression is caused by OMP overhead, different reasoning behavior, or the measured workload itself.

## 10. Testing strategy

### 10.1 Unit tests

Add tests for:

- harness selection and configuration precedence;
- OMP availability/version detection;
- tool-name mapping;
- model/thinking/timeout mapping;
- schema conversion and validation;
- error normalization;
- cancellation and timeout behavior;
- fetch URL validation and response-size limits;
- redaction of secrets from logs.

### 10.2 Workflow-host contract tests

Run small fixture workflows through both hosts and assert identical behavior for:

- `args` access;
- top-level return;
- `agent()` with free-form text;
- `agent()` with a strict schema;
- a failed agent followed by the existing retry policy;
- `parallel()` success and partial failure;
- `pipeline()` ordering;
- nested `workflow()` dispatch at the supported depth;
- phase/log output;
- cancellation;
- terminal marker creation.

Use a fake harness for most tests so they do not depend on a live model. The OMP adapter then gets a smaller live smoke test.

### 10.3 OMP integration tests

With OMP installed, run a minimal fixture that:

- invokes one read-only agent;
- invokes one shell-capable agent in a temporary repository;
- requests a strict structured result;
- attempts a disallowed tool and confirms a normalized permission failure;
- times out and confirms cleanup;
- invokes the optional `web_search` and custom `web_fetch` capabilities separately.

Do not run destructive commands or unrestricted network operations in the test fixture.

### 10.4 End-to-end regression tests

Run the existing e2e test suite in Claude mode before and after the refactor. Then run the same suite in OMP mode with a pinned model/configuration. Confirm that both produce the existing result files, terminal markers, validation outcomes, and exit codes.

### 10.5 Performance and quality A/B tests

Use the same:

- commit and working tree;
- recipe/workload;
- model/backend;
- prompt/schema;
- GPU and server configuration;
- concurrency and timeout settings;
- benchmark repetitions.

Compare median and tail workflow duration, agent-call overhead, benchmark throughput/latency, accepted optimization rate, validation failures, retries, and final artifact quality. A harness is ready for default use only when benchmark measurements are unchanged within the repository's existing tolerance and any search-quality change is understood.

## 11. Phased implementation sequence

### Phase 0 — lock down the contract

- Add this design document and record the current Claude behavior as the compatibility baseline.
- Capture representative prompts, schemas, tool lists, environment variables, exit codes, artifacts, and terminal-marker behavior.
- Add or confirm fake-harness workflow tests before moving code.

### Phase 1 — introduce the neutral contracts

- Add `AgentRequest`, `AgentResult`, normalized errors, `AgentHarness`, and harness selection.
- Add a `WorkflowHost` compatibility layer that reproduces the current injected-global/async-wrapper behavior.
- Keep the existing Claude launch path operational and make the new layer opt-in.

### Phase 2 — implement OMP execution

- Add the Bun/TypeScript OMP adapter using the embedded SDK.
- Implement session creation, tool restriction, structured outputs, cancellation, deadlines, and error mapping.
- Add explicit `web_fetch` only if a current GEAK workflow requires it; otherwise leave it as a capability with a clear unsupported error.
- Add the OMP runner entry point and version/availability diagnostics.

### Phase 3 — connect the external runner

- Add `GEAK_AGENT_HARNESS=omp` to `interface/run_e2e.py`.
- Preserve all existing result normalization, terminal-marker, background monitoring, cleanup, and exit-code logic.
- Add isolated OMP fixtures and run the contract test matrix.

### Phase 4 — add OMP UX integration

- Add the thin `.omp` extension/command.
- Make it call the shared runner.
- Verify cancellation, progress, artifact links, and error messages in an interactive OMP session.

### Phase 5 — converge and document

- Move Claude invocation behind the same `AgentHarness` only after the OMP path passes regression tests.
- Remove duplicated launch/result code where safe.
- Update README, install instructions, compatibility matrix, `pyproject.toml`, and e2e documentation.
- Document the default, fallback, version pin, tool policy, and performance benchmark procedure.

### Phase 6 — controlled rollout

- Keep Claude as the default for one release.
- Enable OMP through an explicit flag/environment variable.
- Collect timing and failure diagnostics with harness labels.
- Promote OMP to a documented supported option only after the A/B acceptance criteria pass.

## 12. Acceptance criteria

The integration is complete when all of the following are true:

- existing Claude workflows run unchanged;
- OMP can execute the same workflow entry point through the compatibility host;
- `agent()` calls support the required tools and strict structured outputs;
- GEAK retains ownership of retries, nesting, parallelism, GPU locks, benchmarks, and artifacts;
- OMP cancellation, timeout, permission, transport, and schema failures map to stable GEAK errors;
- `interface/run_e2e.py` exposes the same external result contract for both harnesses;
- OMP-only installations do not require Claude, and Claude-only installations do not require OMP;
- the OMP extension is a thin frontend over the shared runner;
- the existing Claude regression suite passes;
- OMP smoke/e2e tests pass with a pinned OMP version;
- measured benchmark execution is unchanged within the established tolerance;
- any difference in optimization quality or total search time is reported and attributable;
- documentation explains the harness boundary, configuration, tool mapping, and known limitations.

## 13. Risks and decisions to resolve during implementation

| Risk / decision | Default recommendation |
| --- | --- |
| OMP SDK API changes | Pin a known-good version and add a startup version check. |
| Bun versus Node execution | Use the runtime supported by the installed OMP SDK, preferably Bun; keep the bridge explicit rather than relying on PATH magic. |
| Session reuse leaks context | Start isolated; add measured reuse only with explicit state reset and tests. |
| OMP model defaults differ from Claude | Require an explicit comparison model or document the default; never silently translate names. |
| OMP lacks native `web_fetch` | Add a small GEAK-owned tool/extension with limits, or mark the capability unsupported; never map it to `web_search`. |
| OMP task and GEAK scheduling conflict | Keep GEAK as the top-level scheduler; OMP task remains optional inside an agent. |
| Existing scripts depend on undocumented globals | Build a runtime-global inventory from the repository and fail fast with a named missing-binding error. |
| Interactive approvals hang CI | Use an explicit non-interactive policy and test denied-tool behavior. |
| Provider-specific output envelopes | Normalize once in the adapter and keep provider fields out of workflow code. |
| Extra OMP features alter behavior | Disable MCP/LSP/skills/extensions by default and enable them only through versioned GEAK capabilities. |

This approach adds one clean abstraction at the boundary that is currently hard-coded to Claude Code, while leaving the performance-sensitive GEAK orchestration and benchmark path intact.
