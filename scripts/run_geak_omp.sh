#!/usr/bin/env bash
# Run a GEAK workflow directly through the pinned OMP SDK.
#
# The repository root is derived from this script's location. No checkout path
# or username is embedded in the launcher.
#
# Examples:
#   bash scripts/run_geak_omp.sh kernel \
#     --model provider/model-name \
#     --kernel-path /path/to/kernel \
#     --gpu-ids 0 --budget 2
#
#   bash scripts/run_geak_omp.sh e2e \
#     --model provider/model-name \
#     --model-path /path/to/model \
#     --backend sglang --gpu-ids 0 --tp 1

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
GEAK_ROOT="${GEAK_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd -P)}"
RUNNER="$GEAK_ROOT/geak_runtime/omp_runner.ts"

usage() {
	cat >&2 <<'USAGE'
Usage:
  run_geak_omp.sh kernel --model OMP_MODEL --kernel-path DIR [options]
  run_geak_omp.sh e2e    --model OMP_MODEL --model-path DIR [options]

Common options:
  --model MODEL       OMP model identifier; also accepted from GEAK_OMP_MODEL
  --thinking LEVEL    OMP thinking level; also accepted from GEAK_OMP_THINKING
  --timeout-s SECONDS Workflow timeout; default: 43200
  --exp-root DIR      Output root (optional for kernel, required by e2e)
  --dry-run           Print the generated invocation without running it

Kernel options:
  --kernel-path DIR   Kernel/task directory to optimize
  --budget N          Optimization direction budget; default: 2
  --gpu-ids IDS       Comma-separated GPU IDs; default: 0
  --mode MODE         optimize, author, or bakeoff; default: optimize

End-to-end options:
  --model-path DIR    Model weights directory
  --backend NAME      sglang or vllm; default: sglang
  --gpu-ids IDS       Comma-separated GPU IDs; default: 0
  --tp N               Tensor parallel size; default: 1
  --isl N              Input sequence length; default: 1024
  --osl N              Output sequence length; default: 1024
  --conc N             Concurrency; default: 64

Before running, configure OMP credentials with its normal /login flow or the
provider's API-key environment variable. --model only selects the model.
USAGE
}

fail() {
	echo "run_geak_omp.sh: $*" >&2
	exit 2
}

[[ -f "$RUNNER" ]] || fail "cannot find GEAK runner at $RUNNER"
command -v bun >/dev/null 2>&1 || fail "Bun is required; install Bun >= 1.3.14"
command -v python3 >/dev/null 2>&1 || fail "python3 is required to build the invocation"

MODE="${1:-}"
if [[ "$MODE" == "-h" || "$MODE" == "--help" || -z "$MODE" ]]; then
	usage
	[[ -n "$MODE" ]] && exit 0 || exit 2
fi
shift

case "$MODE" in
	kernel|e2e) ;;
	*) usage; fail "workflow must be 'kernel' or 'e2e'" ;;
esac

OMP_MODEL="${GEAK_OMP_MODEL:-}"
OMP_THINKING="${GEAK_OMP_THINKING:-}"
TIMEOUT_S="${GEAK_OMP_TIMEOUT_S:-43200}"
EXP_ROOT="${GEAK_EXP_ROOT:-}"
GPU_IDS="0"
KERNEL_PATH=""
KERNEL_MODE="optimize"
BUDGET="2"
MODEL_PATH=""
BACKEND="sglang"
TP="1"
ISL="1024"
OSL="1024"
CONC="64"
DRY_RUN=0

need_value() {
	[[ $# -ge 2 && -n "${2:-}" ]] || fail "$1 requires a value"
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--model)
			need_value "$1" "${2:-}"
			OMP_MODEL="$2"
			shift 2
			;;
		--thinking)
			need_value "$1" "${2:-}"
			OMP_THINKING="$2"
			shift 2
			;;
		--timeout-s)
			need_value "$1" "${2:-}"
			TIMEOUT_S="$2"
			shift 2
			;;
		--exp-root)
			need_value "$1" "${2:-}"
			EXP_ROOT="$2"
			shift 2
			;;
		--gpu-ids)
			need_value "$1" "${2:-}"
			GPU_IDS="$2"
			shift 2
			;;
		--kernel-path)
			need_value "$1" "${2:-}"
			KERNEL_PATH="$2"
			shift 2
			;;
		--mode)
			need_value "$1" "${2:-}"
			KERNEL_MODE="$2"
			shift 2
			;;
		--budget)
			need_value "$1" "${2:-}"
			BUDGET="$2"
			shift 2
			;;
		--model-path)
			need_value "$1" "${2:-}"
			MODEL_PATH="$2"
			shift 2
			;;
		--backend)
			need_value "$1" "${2:-}"
			BACKEND="$2"
			shift 2
			;;
		--tp)
			need_value "$1" "${2:-}"
			TP="$2"
			shift 2
			;;
		--isl)
			need_value "$1" "${2:-}"
			ISL="$2"
			shift 2
			;;
		--osl)
			need_value "$1" "${2:-}"
			OSL="$2"
			shift 2
			;;
		--conc)
			need_value "$1" "${2:-}"
			CONC="$2"
			shift 2
			;;
		--dry-run)
			DRY_RUN=1
			shift
			;;
		-h|--help)
			usage
			exit 0
			;;
		*)
			usage
			fail "unknown option: $1"
			;;
	esac
done

[[ -n "$OMP_MODEL" ]] || fail "an OMP model is required; pass --model MODEL or set GEAK_OMP_MODEL"
[[ "$TIMEOUT_S" =~ ^[0-9]+$ ]] || fail "--timeout-s must be a non-negative integer"

if [[ "$MODE" == "kernel" ]]; then
	[[ -n "$KERNEL_PATH" ]] || fail "kernel mode requires --kernel-path DIR"
	[[ -d "$KERNEL_PATH" ]] || fail "kernel path is not a directory: $KERNEL_PATH"
	KERNEL_PATH="$(cd "$KERNEL_PATH" && pwd -P)"
	WORKFLOW_SCRIPT="$GEAK_ROOT/kernel_workflow/kernel_workflow.js"
	WORKFLOW_DIR="$GEAK_ROOT/kernel_workflow"
else
	[[ -n "$MODEL_PATH" ]] || fail "e2e mode requires --model-path DIR"
	[[ -d "$MODEL_PATH" ]] || fail "model path is not a directory: $MODEL_PATH"
	MODEL_PATH="$(cd "$MODEL_PATH" && pwd -P)"
	[[ "$BACKEND" == "sglang" || "$BACKEND" == "vllm" ]] || fail "--backend must be sglang or vllm"
	WORKFLOW_SCRIPT="$GEAK_ROOT/e2e_workflow/e2e_workflow.js"
	WORKFLOW_DIR="$GEAK_ROOT/e2e_workflow"
	EXP_ROOT="${EXP_ROOT:-$GEAK_ROOT/exp}"
	mkdir -p "$EXP_ROOT"
fi

echo "[geak] repository: $GEAK_ROOT" >&2
echo "[geak] workflow:   $WORKFLOW_SCRIPT" >&2
echo "[geak] omp model:  $OMP_MODEL" >&2
echo "[geak] checking OMP SDK..." >&2
GEAK_AGENT_HARNESS=omp GEAK_OMP_MODEL="$OMP_MODEL" \
	GEAK_OMP_THINKING="$OMP_THINKING" bun "$RUNNER" --diagnostics >&2

export GEAK_ROOT OMP_MODEL OMP_THINKING TIMEOUT_S EXP_ROOT
export GPU_IDS KERNEL_PATH KERNEL_MODE BUDGET MODEL_PATH BACKEND TP ISL OSL CONC
export WORKFLOW_SCRIPT WORKFLOW_DIR MODE DRY_RUN

INVOCATION_FILE="$(mktemp "${TMPDIR:-/tmp}/geak-omp-invocation.XXXXXX.json")"
trap 'rm -f "$INVOCATION_FILE"' EXIT

python3 - <<'PY' > "$INVOCATION_FILE"
import json
import os
import time

mode = os.environ["MODE"]
if mode == "kernel":
    workflow_args = {
        "kernel_path": os.environ["KERNEL_PATH"],
        "workflow_dir": os.environ["WORKFLOW_DIR"],
        "mode": os.environ["KERNEL_MODE"],
        "budget": int(os.environ["BUDGET"]),
        "gpu_ids": os.environ["GPU_IDS"],
        "apply_to_original": "false",
    }
else:
    workflow_args = {
        "model_path": os.environ["MODEL_PATH"],
        "workflow_dir": os.environ["WORKFLOW_DIR"],
        "backend": os.environ["BACKEND"],
        "gpu_ids": os.environ["GPU_IDS"],
        "tp": int(os.environ["TP"]),
        "isl": int(os.environ["ISL"]),
        "osl": int(os.environ["OSL"]),
        "conc": int(os.environ["CONC"]),
        "exp_root": os.environ["EXP_ROOT"],
    }

invocation = {
    "schema_version": 1,
    "harness": "omp",
    "repository_root": os.environ["GEAK_ROOT"],
    "workspace": os.environ["GEAK_ROOT"],
    "workflow_script": os.environ["WORKFLOW_SCRIPT"],
    "workflow_args": workflow_args,
    "model": os.environ["OMP_MODEL"],
    "thinking": os.environ["OMP_THINKING"] or None,
    "timeout_ms": int(os.environ["TIMEOUT_S"]) * 1000,
    "run_id": f"omp-{mode}-{int(time.time())}",
}

if os.environ["EXP_ROOT"] and mode == "kernel":
    workflow_args["exp_root"] = os.environ["EXP_ROOT"]

print(json.dumps(invocation))
PY

if [[ "$DRY_RUN" == 1 ]]; then
	python3 -m json.tool "$INVOCATION_FILE"
	exit 0
fi

GEAK_AGENT_HARNESS=omp GEAK_OMP_MODEL="$OMP_MODEL" GEAK_OMP_THINKING="$OMP_THINKING" \
	bun "$RUNNER" --invocation "$INVOCATION_FILE"
