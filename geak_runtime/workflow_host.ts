import { existsSync } from "node:fs";
import { readFile, writeFile, rename } from "node:fs/promises";
import vm from "node:vm";
import path from "node:path";
import { makeAgentBinding } from "./harness";
import { createWorkflowPrimitives } from "./workflow_primitives";
import { AgentAbortError, type AgentHarness } from "./types";

export interface WorkflowHostOptions {
	repositoryRoot: string;
	cwd?: string;
	harness: AgentHarness;
	maxDepth?: number;
	onPhase?: (name: string) => void;
	onLog?: (...parts: unknown[]) => void;
}

export interface WorkflowRunOptions {
	depth?: number;
	signal?: AbortSignal;
}

function inside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function wrapWorkflowSource(source: string): string {
	// GEAK workflow files use one exported metadata declaration followed by a
	// top-level return. Replacing only that declaration keeps the source intact
	// while making the existing async-function contract executable under Bun.
	const transformed = source.replace(/\bexport\s+const\s+meta\s*=/, "const meta =");
	if (/\bexport\s+(?!const\s+meta\b)/.test(transformed)) throw new Error("workflow host found an unsupported export; only `export const meta` is allowed");
	return `(async function(args, agent, workflow, parallel, pipeline, phase, log) {\n${transformed}\n})`;
}

export class WorkflowHost {
	readonly repositoryRoot: string;
	readonly cwd: string;
	readonly harness: AgentHarness;
	readonly maxDepth: number;
	private readonly onPhase?: (name: string) => void;
	private readonly onLog?: (...parts: unknown[]) => void;

	constructor(options: WorkflowHostOptions) {
		this.repositoryRoot = path.resolve(options.repositoryRoot);
		this.cwd = path.resolve(options.cwd ?? this.repositoryRoot);
		this.harness = options.harness;
		this.maxDepth = options.maxDepth ?? 2;
		this.onPhase = options.onPhase;
		this.onLog = options.onLog;
	}

	async run(scriptPath: string, args: Record<string, any> = {}, options: WorkflowRunOptions = {}): Promise<any> {
		const depth = options.depth ?? 0;
		if (options.signal?.aborted) throw new AgentAbortError("workflow was aborted");
		if (depth > this.maxDepth) throw new Error(`workflow nesting depth ${depth} exceeds GEAK limit ${this.maxDepth}`);
		const resolvedScript = path.resolve(this.repositoryRoot, scriptPath);
		if (!inside(this.repositoryRoot, resolvedScript)) throw new Error(`workflow script is outside repository root: ${resolvedScript}`);
		if (path.extname(resolvedScript) !== ".js") throw new Error(`workflow script must be JavaScript: ${resolvedScript}`);
		if (!existsSync(resolvedScript)) throw new Error(`workflow script does not exist: ${resolvedScript}`);
		const source = await readFile(resolvedScript, "utf8");
		const phase = (name: string) => {
			this.onPhase?.(String(name));
			this.onLog?.(`[phase] ${String(name)}`);
		};
		const log = (...parts: unknown[]) => this.onLog?.(...parts);
		const primitives = createWorkflowPrimitives({ host: this, args, depth, signal: options.signal, phase, log });
		const agent = makeAgentBinding(this.harness, { cwd: String(args.cwd || this.cwd), signal: options.signal });
		// Evaluate only the validated workflow source in a context containing the
		// documented GEAK globals. This preserves the current top-level-return
		// wrapper while keeping host/process/Bun state out of workflow scope.
		const factory = vm.runInNewContext(`(${wrapWorkflowSource(source)})`, {
			args,
			agent,
			workflow: primitives.workflow,
			parallel: primitives.parallel,
			pipeline: primitives.pipeline,
			phase,
			log,
			setTimeout,
			clearTimeout,
			setInterval,
			clearInterval,
			queueMicrotask,
			console: { log: (...parts: unknown[]) => this.onLog?.(...parts) },
		}, { filename: resolvedScript }) as Function;
		const result = await factory(args, agent, primitives.workflow, primitives.parallel, primitives.pipeline, phase, log);
		await this.persistWorkflowMarker(result);
		return result;
	}

	private async persistWorkflowMarker(result: unknown): Promise<void> {
		if (!result || typeof result !== "object" || Array.isArray(result)) return;
		const evalDir = (result as Record<string, unknown>).eval_dir;
		if (typeof evalDir !== "string" || !evalDir) return;
		const marker = path.join(evalDir, "workflow_return.json");
		if (existsSync(marker)) return;
		try {
			const temporary = `${marker}.tmp-${process.pid}`;
			await writeFile(temporary, JSON.stringify(result, null, 2), "utf8");
			await rename(temporary, marker);
		} catch (error) {
			this.onLog?.(`[marker] unable to persist ${marker}: ${String(error)}`);
		}
	}
}
