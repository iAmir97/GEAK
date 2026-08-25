# OMP integration baseline

This is the Phase 0 compatibility record for the harness boundary. It is kept
small and machine-auditable; the existing Python and JavaScript tests remain the
authoritative regression suite for the benchmark and artifact contracts.

| Contract | Claude baseline | OMP bridge contract |
| --- | --- | --- |
| Workflow entry | `e2e_workflow/e2e_workflow.js` via Claude Workflow | same script via `geak_runtime/WorkflowHost` |
| Injected globals | `args`, `agent`, `workflow`, `parallel`, `pipeline`, `phase`, `log` | same names and async wrapper |
| Nested execution | GEAK workflow nesting and ordering | host-enforced depth limit (`2` for e2e → kernel → lane) |
| Agent result | structured object when `schema` is requested; text otherwise | same unwrapped value from `AgentResult` |
| Tool policy | `Workflow`, `Bash`, `Read`, `Write`, `WebSearch`, `WebFetch` | `bash`, `read`, `write`, `edit`, `grep`, `glob`, `web_search`, optional GEAK `web_fetch` |
| Retry/deadline owner | JavaScript workflow (`agentT`/`safeAgent`) and Python outer timeout | unchanged; OMP reports failures and does not retry |
| Terminal marker | `workflow_return.json` or `director_e2e_validation.json` | workflow marker preserved; host writes `workflow_return.json` only as a non-overwriting fallback |
| External handoff | `interface/run_e2e.py` JSON contract | same result file, marker, artifact, and exit-code path |

Representative prompts and schemas are the role prompts and schema constants
already present in `kernel_workflow/*.js` and `e2e_workflow/e2e_workflow.js`.
The fake-host matrix in `geak_runtime/tests/runtime.test.ts` covers argument
access, free-form and structured agent calls, retries at the workflow boundary,
parallel/pipeline ordering, nested dispatch, phase/log output, cancellation,
and terminal marker creation. Live model tests remain opt-in because they need
provider credentials and must not mutate benchmark workspaces.
