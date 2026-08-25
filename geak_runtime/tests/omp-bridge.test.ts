import { describe, expect, test } from "bun:test";
import { resolveHarnessConfig } from "../config";
import { parseStructuredOutput } from "../schema";
import { OmpHarness } from "../omp_harness";
import { AgentAbortError, AgentPermissionError, AgentStructuredOutputError, AgentTimeoutError } from "../types";

describe("OMP adapter boundary", () => {
	test("diagnostic configuration is explicit and isolated", () => {
		const config = resolveHarnessConfig(process.cwd(), "omp");
		expect(config.harness).toBe("omp");
		expect(config.ompEnableMcp).toBe(false);
		expect(config.ompEnableLsp).toBe(false);
		expect(config.ompAllowedTools).toContain("web_search");
	});

	test("strict structured output rejects malformed payloads", () => {
		expect(() => parseStructuredOutput("not json", { type: "object" })).toThrow(AgentStructuredOutputError);
	});

	test("adapter is constructible without starting a model session", async () => {
		const harness = new OmpHarness(resolveHarnessConfig(process.cwd(), "omp"));
		await harness.close();
		// The class intentionally defers SDK session construction until run().
		expect(harness).toBeInstanceOf(OmpHarness);
	});

	test("permission errors remain a distinct stable type", () => {
		expect(new AgentPermissionError("disallowed tool").code).toBe("permission");
	});

	test("maps structured output and provider controls through the OMP session", async () => {
		const config = {
			...resolveHarnessConfig(process.cwd(), "omp"),
			ompModule: new URL("./fixtures/fake_omp.ts", import.meta.url).pathname,
			ompAllowedTools: ["read"],
			ompTimeoutGraceMs: 10,
		};
		const harness = new OmpHarness(config);
		const result = await harness.run({
			prompt: "return JSON",
			cwd: process.cwd(),
			tools: ["read"],
			outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
		});
		expect(result.data).toEqual({ answer: "structured" });
		expect(result.provider).toBe("omp");
		await expect(harness.run({ prompt: "bad tool", cwd: process.cwd(), tools: ["bash"] })).rejects.toBeInstanceOf(AgentPermissionError);
		await harness.close();
	});

	test("normalizes pre-cancel and session deadline failures", async () => {
		const config = {
			...resolveHarnessConfig(process.cwd(), "omp"),
			ompModule: new URL("./fixtures/fake_omp.ts", import.meta.url).pathname,
			ompAllowedTools: ["read"],
			ompTimeoutGraceMs: 10,
		};
		const harness = new OmpHarness(config);
		const cancelled = new AbortController();
		cancelled.abort();
		await expect(harness.run({ prompt: "cancel", cwd: process.cwd(), signal: cancelled.signal })).rejects.toBeInstanceOf(AgentAbortError);
		await expect(harness.run({ prompt: "slow", cwd: process.cwd(), model: "slow", timeoutMs: 1 })).rejects.toBeInstanceOf(AgentTimeoutError);
		await harness.close();
	});
});
