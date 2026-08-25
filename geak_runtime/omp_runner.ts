import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveHarnessConfig, DEFAULT_OMP_VERSION } from "./config";
import { detectOmpVersion, OmpHarness } from "./omp_harness";
import { WorkflowHost } from "./workflow_host";
import { AgentError, errorCode, type HarnessName } from "./types";

export interface OmpInvocation {
	schema_version?: number;
	harness?: HarnessName;
	repository_root: string;
	workspace?: string;
	workflow_script: string;
	workflow_args?: Record<string, any>;
	model?: string;
	thinking?: string;
	timeout_ms?: number;
	allowed_tools?: string[];
	artifact_paths?: string[];
	environment?: Record<string, string>;
	run_id?: string;
	max_depth?: number;
}

async function readInvocation(argv: string[]): Promise<OmpInvocation> {
	const index = argv.indexOf("--invocation");
	if (index >= 0 && argv[index + 1]) return JSON.parse(await readFile(argv[index + 1], "utf8"));
	if (!argv.includes("--stdin")) throw new Error("OMP runner requires --invocation <json-file>, --stdin, or --diagnostics");
	const stdin = await new Response(Bun.stdin.stream()).text();
	return JSON.parse(stdin);
}

async function diagnostics(): Promise<number> {
	const config = resolveHarnessConfig(process.cwd(), "omp");
	const result = { harness: "omp", configured_version: config.ompVersion, expected_version: DEFAULT_OMP_VERSION, detected_version: null as string | null, command: config.ompCommand, module: config.ompModule || null };
	try {
		const harness = new OmpHarness(config);
		await harness.ready();
		const detected = await detectOmpVersion(config);
		await harness.close();
		const status = detected && detected !== config.ompVersion ? "version_mismatch" : "available";
		console.log(JSON.stringify({ ...result, detected_version: detected || null, status }));
		return status === "available" ? 0 : 1;
	} catch (error) {
		console.log(JSON.stringify({ ...result, status: "unavailable", error: String(error) }));
		return 1;
	}
}

export async function runInvocation(invocation: OmpInvocation): Promise<unknown> {
	if (invocation.harness && invocation.harness !== "omp") throw new Error(`OMP runner received harness=${invocation.harness}`);
	const repositoryRoot = path.resolve(invocation.repository_root);
	const workspace = path.resolve(invocation.workspace || repositoryRoot);
	for (const [key, value] of Object.entries(invocation.environment || {})) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid invocation environment variable: ${key}`);
		process.env[key] = String(value);
	}
	const config = resolveHarnessConfig(repositoryRoot, "omp");
	if (invocation.model) config.ompModel = invocation.model;
	if (invocation.thinking) config.ompThinking = invocation.thinking;
	if (invocation.allowed_tools) config.ompAllowedTools = invocation.allowed_tools;
	const harness = new OmpHarness(config);
	const controller = new AbortController();
	const timeout = invocation.timeout_ms && invocation.timeout_ms > 0 ? setTimeout(() => controller.abort("workflow deadline"), invocation.timeout_ms) : undefined;
	try {
		const host = new WorkflowHost({
			repositoryRoot,
			cwd: workspace,
			harness,
			maxDepth: invocation.max_depth ?? 2,
			onPhase: phase => process.stderr.write(`[geak omp] phase=${phase}\n`),
			onLog: (...parts) => process.stderr.write(`[geak omp] ${parts.map(String).join(" ")}\n`),
		});
		return await host.run(invocation.workflow_script, invocation.workflow_args || {}, { signal: controller.signal });
	} finally {
		if (timeout) clearTimeout(timeout);
		await harness.close();
	}
}

if (import.meta.main && (process.argv.includes("--diagnostics") || process.argv.includes("--invocation") || process.argv.includes("--stdin"))) {
	if (process.argv.includes("--diagnostics")) process.exit(await diagnostics());
	try {
		const result = await runInvocation(await readInvocation(process.argv.slice(2)));
		process.stdout.write(`${JSON.stringify(result)}\n`);
	} catch (error) {
		const code = errorCode(error);
		process.stderr.write(`[geak omp] failed [${code}]: ${error instanceof AgentError ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
