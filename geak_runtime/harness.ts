import type { AgentHarness, AgentRequest, AgentResult } from "./types";

export type AgentBinding = (prompt: string, options?: Record<string, any>) => Promise<unknown>;

export function resultValue<T>(result: AgentResult<T>): T | string | null {
	if (result.data !== undefined) return result.data;
	if (result.text !== undefined) return result.text;
	return null;
}

export function makeAgentBinding(harness: AgentHarness, defaults: { cwd: string; signal?: AbortSignal }): AgentBinding {
	return async (prompt, options = {}) => {
		const schema = options.schema ?? options.outputSchema;
		const request: AgentRequest = {
			prompt,
			cwd: String(options.cwd ?? defaults.cwd),
			tools: options.tools,
			outputSchema: schema,
			outputSchemaMode: schema === undefined ? undefined : (options.outputSchemaMode ?? "strict"),
			model: options.model,
			thinking: options.thinking ?? options.effort,
			timeoutMs: options.timeoutMs,
			signal: options.signal ?? defaults.signal,
			metadata: { ...options.metadata, phase: options.phase, label: options.label },
		};
		return resultValue(await harness.run(request));
	};
}
