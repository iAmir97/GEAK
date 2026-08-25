import type { WorkflowHost } from "./workflow_host";
import { AgentAbortError } from "./types";

export interface PrimitiveContext {
	host: WorkflowHost;
	args: Record<string, any>;
	depth: number;
	signal?: AbortSignal;
	phase: (name: string) => void;
	log: (...parts: unknown[]) => void;
}

export function createWorkflowPrimitives(context: PrimitiveContext) {
	const workflow = async (reference: { scriptPath?: string } | string, childArgs: Record<string, any> = {}) => {
		if (context.signal?.aborted) throw new AgentAbortError("workflow was aborted");
		const scriptPath = typeof reference === "string" ? reference : reference?.scriptPath;
		if (!scriptPath) throw new Error("workflow() requires scriptPath");
		return context.host.run(scriptPath, childArgs, { depth: context.depth + 1, signal: context.signal });
	};

	const parallel = async <T>(jobs: Array<(() => T | Promise<T>) | Promise<T>>): Promise<T[]> => {
		if (context.signal?.aborted) throw new AgentAbortError("parallel workflow was aborted");
		return Promise.all(jobs.map(job => typeof job === "function" ? job() : job));
	};

	const pipeline = async <T>(items: T[], ...stages: Array<(item: any, index: number) => any>): Promise<any[]> => {
		let values: any[] = [...items];
		for (const stage of stages) {
			if (context.signal?.aborted) throw new AgentAbortError("pipeline was aborted");
			values = await Promise.all(values.map((item, index) => stage(item, index)));
		}
		return values;
	};

	return { workflow, parallel, pipeline, phase: context.phase, log: context.log };
}
