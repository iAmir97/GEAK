import { afterAll, describe, expect, test } from "bun:test";
import { resolveHarnessConfig } from "../config";
import { parseStructuredOutput } from "../schema";
import { OmpHarness } from "../omp_harness";
import { AgentAbortError, AgentPermissionError, AgentStructuredOutputError, AgentTimeoutError } from "../types";

// These tests exercise extension ON/OFF boundaries, so ambient GEAK_OMP_*
// values (a caller's GEAK_OMP_ENABLE_EXTENSIONS=1, pinned extension paths)
// must not leak into config resolution. Save and pin for the suite, mirroring
// the save/restore pattern in runtime.test.ts.
const savedExtensionEnv = {
	enable: process.env.GEAK_OMP_ENABLE_EXTENSIONS,
	paths: process.env.GEAK_OMP_EXTENSION_PATHS,
};
delete process.env.GEAK_OMP_ENABLE_EXTENSIONS;
delete process.env.GEAK_OMP_EXTENSION_PATHS;
afterAll(() => {
	if (savedExtensionEnv.enable === undefined) delete process.env.GEAK_OMP_ENABLE_EXTENSIONS;
	else process.env.GEAK_OMP_ENABLE_EXTENSIONS = savedExtensionEnv.enable;
	if (savedExtensionEnv.paths === undefined) delete process.env.GEAK_OMP_EXTENSION_PATHS;
	else process.env.GEAK_OMP_EXTENSION_PATHS = savedExtensionEnv.paths;
});
describe("OMP adapter boundary", () => {
	test("diagnostic configuration is explicit and isolated", () => {
		const config = resolveHarnessConfig(process.cwd(), "omp");
		expect(config.harness).toBe("omp");
		expect(config.ompEnableMcp).toBe(false);
		expect(config.ompEnableLsp).toBe(false);
		expect(config.ompEnableExtensions).toBe(false);
		expect(config.ompExtensionPaths).toEqual([]);
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

	test("loads explicitly configured provider extensions without ambient discovery", async () => {
		const config = {
			...resolveHarnessConfig(process.cwd(), "omp"),
			ompModule: new URL("./fixtures/fake_omp.ts", import.meta.url).pathname,
			ompAllowedTools: ["read"],
			ompExtensionPaths: ["/root/.omp/plugins/node_modules/tokenvisor-pi/extensions/tokenvisor-provider.ts"],
			ompTimeoutGraceMs: 10,
		};
		const harness = new OmpHarness(config);
		await harness.run({ prompt: "provider", cwd: process.cwd(), tools: ["read"] });
		const fake = await import("./fixtures/fake_omp.ts");
		expect(fake.lastOptions?.disableExtensionDiscovery).toBe(false);
		expect(fake.lastOptions?.additionalExtensionPaths).toEqual([
			"/root/.omp/plugins/node_modules/tokenvisor-pi/extensions/tokenvisor-provider.ts",
		]);
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

	test("preloads extension providers into a shared catalog when extensions are enabled", async () => {
		const config = {
			...resolveHarnessConfig(process.cwd(), "omp"),
			ompModule: new URL("./fixtures/fake_omp.ts", import.meta.url).pathname,
			ompAllowedTools: ["read"],
			ompEnableExtensions: true,
			ompTimeoutGraceMs: 10,
		};
		const harness = new OmpHarness(config);
		await harness.run({ prompt: "catalog", cwd: process.cwd(), tools: ["read"] });
		const fake = await import("./fixtures/fake_omp.ts");
		const call = fake.catalogCalls.at(-1);
		expect(call?.cwd).toBe(process.cwd());
		expect(call?.options.disableExtensionDiscovery).toBe(false);
		const options = fake.lastOptions;
		expect(options?.modelRegistry).toBe(call?.options.modelRegistry);
		expect(options?.settings).toBe(call?.options.settings);
		expect(options?.authStorage).toBe(call?.options.modelRegistry?.authStorage);
		const closedBefore = fake.closedAuthStorages.length;
		await harness.close();
		expect(fake.closedAuthStorages.length).toBe(closedBefore + 1);
	});

	test("loads only explicit extension paths when ambient discovery stays off", async () => {
		const config = {
			...resolveHarnessConfig(process.cwd(), "omp"),
			ompModule: new URL("./fixtures/fake_omp.ts", import.meta.url).pathname,
			ompAllowedTools: ["read"],
			ompExtensionPaths: ["/root/.omp/plugins/node_modules/tokenvisor-pi/extensions/tokenvisor-provider.ts"],
			ompTimeoutGraceMs: 10,
		};
		const harness = new OmpHarness(config);
		await harness.run({ prompt: "explicit catalog", cwd: process.cwd(), tools: ["read"] });
		const fake = await import("./fixtures/fake_omp.ts");
		const call = fake.catalogCalls.at(-1);
		expect(call?.options.disableExtensionDiscovery).toBe(true);
		expect(call?.options.additionalExtensionPaths).toEqual([
			"/root/.omp/plugins/node_modules/tokenvisor-pi/extensions/tokenvisor-provider.ts",
		]);
		await harness.close();
	});

	test("skips the shared catalog when extensions stay disabled", async () => {
		const config = {
			...resolveHarnessConfig(process.cwd(), "omp"),
			ompModule: new URL("./fixtures/fake_omp.ts", import.meta.url).pathname,
			ompAllowedTools: ["read"],
			ompTimeoutGraceMs: 10,
		};
		const harness = new OmpHarness(config);
		const fake = await import("./fixtures/fake_omp.ts");
		const callsBefore = fake.catalogCalls.length;
		await harness.run({ prompt: "isolated", cwd: process.cwd(), tools: ["read"] });
		expect(fake.catalogCalls.length).toBe(callsBefore);
		expect(fake.lastOptions?.modelRegistry).toBeUndefined();
		expect(fake.lastOptions?.settings).toBeUndefined();
		expect(fake.lastOptions?.authStorage).toBeUndefined();
		await harness.close();
	});

	test("reuses one catalog across every agent call in a run", async () => {
		const config = {
			...resolveHarnessConfig(process.cwd(), "omp"),
			ompModule: new URL("./fixtures/fake_omp.ts", import.meta.url).pathname,
			ompAllowedTools: ["read"],
			ompEnableExtensions: true,
			ompTimeoutGraceMs: 10,
		};
		const harness = new OmpHarness(config);
		const fake = await import("./fixtures/fake_omp.ts");
		const callsBefore = fake.catalogCalls.length;
		await harness.run({ prompt: "first", cwd: process.cwd(), tools: ["read"] });
		const first = fake.lastOptions;
		await harness.run({ prompt: "second", cwd: process.cwd(), tools: ["read"] });
		expect(fake.catalogCalls.length).toBe(callsBefore + 1);
		expect(fake.lastOptions?.modelRegistry).toBe(first?.modelRegistry);
		await harness.close();
	});
});
