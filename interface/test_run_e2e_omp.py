"""Contract tests for the optional OMP path in interface/run_e2e.py."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

_HERE = Path(__file__).resolve().parent
_SPEC = importlib.util.spec_from_file_location("run_e2e_omp", _HERE / "run_e2e.py")
rx = importlib.util.module_from_spec(_SPEC)
assert _SPEC.loader is not None
_SPEC.loader.exec_module(rx)


def test_harness_precedence_and_cli_extraction(tmp_path, monkeypatch):
    config_dir = tmp_path / ".geak"
    config_dir.mkdir()
    (config_dir / "config.json").write_text(json.dumps({"agent_harness": "omp"}), encoding="utf-8")
    monkeypatch.setattr(rx, "GEAK_ROOT", tmp_path)
    monkeypatch.delenv("GEAK_AGENT_HARNESS", raising=False)
    assert rx.resolve_agent_harness() == "omp"
    monkeypatch.setenv("GEAK_AGENT_HARNESS", "claude")
    assert rx.resolve_agent_harness() == "claude"
    remaining, explicit = rx._extract_harness_arg(["a", "b", "--harness", "omp", "--dry-run"])
    assert remaining == ["a", "b", "--dry-run"]
    assert explicit == "omp"


def test_omp_invocation_is_explicit_and_does_not_serialize_credentials(monkeypatch, tmp_path):
    monkeypatch.setattr(rx, "GEAK_ROOT", tmp_path)
    monkeypatch.setattr(rx, "E2E_DIR", tmp_path / "e2e")
    monkeypatch.setattr(rx, "E2E_SCRIPT", tmp_path / "e2e" / "e2e_workflow.js")
    monkeypatch.setenv("BENCH_CLIENT", "native")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "secret")
    invocation = rx._build_omp_invocation(
        {"eval_dir": "/tmp/eval", "workflow_dir": str(tmp_path)},
        {"run_id": "run-1"},
        123,
        tmp_path / "result.json",
    )
    assert invocation["repository_root"] == str(tmp_path)
    assert invocation["workflow_script"].endswith("e2e_workflow.js")
    assert invocation["timeout_ms"] == 123000
    assert invocation["run_id"] == "run-1"
    assert invocation["environment"]["BENCH_CLIENT"] == "native"
    assert "ANTHROPIC_API_KEY" not in invocation["environment"]


def test_omp_runner_preserves_stdout_contract(monkeypatch, tmp_path):
    runner = tmp_path / "omp_runner.ts"
    runner.write_text("// fixture", encoding="utf-8")
    monkeypatch.setattr(rx, "OMP_RUNNER", runner)
    monkeypatch.setattr(rx.shutil, "which", lambda name: "/usr/bin/bun")

    seen = {}

    class Proc:
        returncode = 0

        def wait(self, timeout=None):
            return self.returncode

        def kill(self):
            self.returncode = -9

    def fake_popen(cmd, **kwargs):
        seen["cmd"] = cmd
        seen["invocation"] = json.loads(Path(cmd[-1]).read_text(encoding="utf-8"))
        kwargs["stdout"].write('{"eval_dir":"/tmp/eval"}\n')
        kwargs["stdout"].flush()
        kwargs["stderr"].write("phase output")
        kwargs["stderr"].flush()
        return Proc()

    monkeypatch.setattr(rx.subprocess, "Popen", fake_popen)
    raw = rx._invoke_via_omp({"harness": "omp", "workflow_script": "x"}, 10)
    assert json.loads(raw)["eval_dir"] == "/tmp/eval"
    assert seen["cmd"][0] == "/usr/bin/bun"
    assert seen["cmd"][1] == str(runner)
    assert seen["invocation"]["harness"] == "omp"


def test_main_dry_run_exposes_omp_without_touching_workflow(tmp_path, capsys):
    handoff = tmp_path / "handoff.json"
    result = tmp_path / "result.json"
    handoff.write_text(json.dumps({
        "model_path": "/models/fake",
        "exp_root": str(tmp_path / "exp"),
        "framework": "vllm",
    }), encoding="utf-8")
    assert rx.main([str(handoff), str(result), "--harness", "omp", "--dry-run"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["harness"] == "omp"
    assert payload["mapped_args"]["workflow_dir"].endswith("e2e_workflow")


@pytest.mark.parametrize(
    "message, expected",
    [
        ("omp runner failed: [permission] denied", "permission"),
        ("omp runner failed: [structured_output] schema mismatch", "structured_output"),
        ("omp harness unavailable: Bun was not found", "harness_unavailable"),
        ("omp runner failed: [transport] connection failed", "transport"),
    ],
)
def test_omp_errors_have_stable_classes(message, expected):
    assert rx._classify_error(RuntimeError(message)) == expected
