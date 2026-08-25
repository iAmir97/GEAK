import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalToolName, resolveHarnessConfig } from "../config";
import { parseStructuredOutput, validateJsonSchema } from "../schema";
import { AgentAbortError, type AgentHarness, type AgentRequest, type AgentResult } from "../types";
import { fetchUrl, validateFetchUrl } from "../web_fetch";
import { WorkflowHost } from "../workflow_host";

class FakeHarness implements AgentHarness {
	calls: AgentRequest[] = [];
	responses: Array<AgentResult | Error> = [];

	async run<T>(request: AgentRequest): Promise<AgentResult<T>> {
		this.calls.push(request);
		const response = this.responses.shift();
		if (response instanceof Error) throw response;
		return (response || { text: "fake response", provider: "omp" }) as AgentResult<T>;
	}
}

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "geak-runtime-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function fixture(name: string, source: string): Promise<string> {
	const file = path.join(root, name);
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, source, "utf8");
	return file;
}

describe("harness configuration", () => {
	const savedHarness = process.env.GEAK_AGENT_HARNESS;
	const savedTools = process.env.GEAK_OMP_ALLOWED_TOOLS;
	afterEach(() => {
		if (savedHarness === undefined) delete process.env.GEAK_AGENT_HARNESS;
		else process.env.GEAK_AGENT_HARNESS = savedHarness;
		if (savedTools === undefined) delete process.env.GEAK_OMP_ALLOWED_TOOLS;
		else process.env.GEAK_OMP_ALLOWED_TOOLS = savedTools;
	});

	test("uses explicit > environment > repository > default precedence", async () => {
		await mkdir(path.join(root, ".geak"), { recursive: true });
		await writeFile(path.join(root, ".geak", "config.json"), JSON.stringify({ agent_harness: "omp" }));
		delete process.env.GEAK_AGENT_HARNESS;
		expect(resolveHarnessConfig(root).harness).toBe("omp");
		process.env.GEAK_AGENT_HARNESS = "claude";
		expect(resolveHarnessConfig(root).harness).toBe("claude");
		expect(resolveHarnessConfig(root, "omp").harness).toBe("omp");
	});

	test("keeps OMP-only settings under the OMP namespace", () => {
		process.env.GEAK_OMP_ALLOWED_TOOLS = "bash,read,read,web_fetch";
		const config = resolveHarnessConfig(root, "omp");
		expect(config.ompAllowedTools).toEqual(["bash", "read", "web_fetch"]);
		expect(canonicalToolName("WebFetch")).toBe("web_fetch");
	});
});

describe("schema boundary", () => {
	const schema = {
		type: "object",
		properties: { answer: { type: "string" }, count: { type: "integer" } },
		required: ["answer"],
		additionalProperties: false,
	};

	test("validates required fields and strict extra fields", () => {
		expect(validateJsonSchema({ answer: "ok", count: 2 }, schema)).toEqual([]);
		expect(validateJsonSchema({ count: 2 }, schema)[0].message).toContain("required");
		expect(validateJsonSchema({ answer: "ok", extra: true }, schema)[0].message).toContain("additional");
	});

	test("extracts only schema-valid JSON from provider prose", () => {
		expect(parseStructuredOutput<{ answer: string }>("done\n```json\n{\"answer\":\"ok\"}\n```", schema)).toEqual({ answer: "ok" });
	});
});

describe("workflow host compatibility contract", () => {
	test("injects args, preserves top-level return, and passes schema/options to agent", async () => {
		const script = await fixture("workflow.js", `export const meta = { name: 'fixture' };\nphase('Setup');\nconst answer = await agent('free form', { schema: { type: 'object' }, label: 'fixture' });\nlog('answer', answer.answer);\nreturn { value: args.value, answer };`);
		const harness = new FakeHarness();
		harness.responses.push({ data: { answer: "structured" }, provider: "omp" });
		const phases: string[] = [];
		const logs: string[] = [];
		const result = await new WorkflowHost({ repositoryRoot: root, harness, onPhase: name => phases.push(name), onLog: (...parts) => logs.push(parts.map(String).join(" ")) }).run(script, { value: 7 });
		expect(result).toEqual({ value: 7, answer: { answer: "structured" } });
		expect(phases).toEqual(["Setup"]);
		expect(logs.some(line => line.includes("answer structured"))).toBe(true);
		expect(harness.calls[0].outputSchemaMode).toBe("strict");
	});

	test("does not expose host process state to workflow source", async () => {
		const script = await fixture("scope.js", `return { processType: typeof process, bunType: typeof Bun, value: args.value };`);
		const result = await new WorkflowHost({ repositoryRoot: root, harness: new FakeHarness() }).run(script, { value: 3 });
		expect(result).toEqual({ processType: "undefined", bunType: "undefined", value: 3 });
	});

	test("parallel preserves input ordering and propagates partial failure", async () => {
		const script = await fixture("parallel.js", `const values = await parallel([1, 2, 3].map(value => async () => value * 2)); return values;`);
		const result = await new WorkflowHost({ repositoryRoot: root, harness: new FakeHarness() }).run(script);
		expect(result).toEqual([2, 4, 6]);
		const failing = await fixture("parallel-failing.js", `return await parallel([() => Promise.resolve('ok'), () => Promise.reject(new Error('boom'))]);`);
		await expect(new WorkflowHost({ repositoryRoot: root, harness: new FakeHarness() }).run(failing)).rejects.toThrow("boom");
	});

	test("pipeline stages run in order and nested workflow is bounded", async () => {
		const child = await fixture("child.js", `return { child: args.name };`);
		const parent = await fixture("parent.js", `const values = await pipeline([1, 2], value => value + 1, value => value * 3); const child = await workflow({ scriptPath: '${child}' }, { name: 'nested' }); return { values, child };`);
		const result = await new WorkflowHost({ repositoryRoot: root, harness: new FakeHarness(), maxDepth: 1 }).run(parent);
		expect(result).toEqual({ values: [6, 9], child: { child: "nested" } });
		const tooDeep = await fixture("too-deep.js", `return await workflow({ scriptPath: '${parent}' }, {});`);
		await expect(new WorkflowHost({ repositoryRoot: root, harness: new FakeHarness(), maxDepth: 1 }).run(tooDeep)).rejects.toThrow("nesting depth");
	});

	test("creates the canonical terminal marker without overwriting a workflow marker", async () => {
		const evalDir = path.join(root, "eval");
		await mkdir(evalDir);
		const script = await fixture("marker.js", `return { eval_dir: '${evalDir}', status: 'ok' };`);
		await new WorkflowHost({ repositoryRoot: root, harness: new FakeHarness() }).run(script);
		expect(await Bun.file(path.join(evalDir, "workflow_return.json")).json()).toEqual({ eval_dir: evalDir, status: "ok" });
	});

	test("honors cancellation before entering a workflow", async () => {
		const controller = new AbortController();
		controller.abort();
		const script = await fixture("cancel.js", `return 1;`);
		await expect(new WorkflowHost({ repositoryRoot: root, harness: new FakeHarness() }).run(script, {}, { signal: controller.signal })).rejects.toBeInstanceOf(AgentAbortError);
	});
});

describe("web fetch boundary", () => {
	test("rejects non-http schemes and credentials", () => {
		expect(() => validateFetchUrl("file:///etc/passwd")).toThrow("http(s)");
		expect(() => validateFetchUrl("https://user:pass@example.com")).toThrow("credentials");
	});

	test("does not perform network access for invalid URLs", async () => {
		await expect(fetchUrl("not a url")).rejects.toThrow("valid URL");
	});
});
