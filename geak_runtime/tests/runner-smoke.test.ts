import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectOmpVersion, OmpHarness } from "../omp_harness";
import { runInvocation } from "../omp_runner";
import { resolveHarnessConfig } from "../config";

describe("installed OMP smoke boundary", () => {
	test("loads the pinned SDK and constructs an isolated read-only session", async () => {
		const config = resolveHarnessConfig(process.cwd(), "omp");
		const harness = new OmpHarness(config);
		const runtime = await harness.ready();
		expect(typeof runtime.module.createAgentSession).toBe("function");
		expect(await detectOmpVersion(config)).toBe("17.4.0");
		await harness.close();
	});

	test("runs a fixture through the actual runner and preserves the marker", async () => {
		const root = path.resolve(import.meta.dir, "../..");
		const evalDir = await mkdtemp(path.join(os.tmpdir(), "geak-omp-smoke-"));
		try {
			const result = await runInvocation({
				schema_version: 1,
				harness: "omp",
				repository_root: root,
				workspace: root,
				workflow_script: path.join(import.meta.dir, "fixtures", "host_smoke.js"),
				workflow_args: { eval_dir: evalDir, value: 7 },
				allowed_tools: ["read"],
				max_depth: 2,
			});
			expect(result).toEqual({ eval_dir: evalDir, value: 7, harness: "omp" });
			expect(JSON.parse(await readFile(path.join(evalDir, "workflow_return.json"), "utf8"))).toEqual(result);
		} finally {
			await rm(evalDir, { recursive: true, force: true });
		}
	});
});
