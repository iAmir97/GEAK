/** Harness-neutral contracts used by GEAK workflow hosts and adapters. */

export type HarnessName = "claude" | "omp";
export type OutputSchemaMode = "strict" | "loose";

export interface AgentRequest<TSchema = unknown> {
	prompt: string;
	cwd: string;
	tools?: string[];
	outputSchema?: TSchema;
	outputSchemaMode?: OutputSchemaMode;
	model?: string;
	thinking?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	metadata?: Record<string, unknown>;
}

export interface AgentResult<T = unknown> {
	data?: T;
	text?: string;
	usage?: Record<string, unknown>;
	provider: HarnessName;
	diagnostics?: {
		schemaHash?: string;
		model?: string;
		timingsMs?: Record<string, number>;
		rawText?: string;
	};
}

export type AgentErrorCode =
	| "timeout"
	| "aborted"
	| "permission"
	| "structured_output"
	| "transport"
	| "unavailable";

export class AgentError extends Error {
	readonly code: AgentErrorCode;
	readonly provider?: HarnessName;
	readonly retryable: boolean;
	readonly details?: Record<string, unknown>;

	constructor(
		code: AgentErrorCode,
		message: string,
		options: {
			provider?: HarnessName;
			retryable?: boolean;
			details?: Record<string, unknown>;
			cause?: unknown;
		} = {},
	) {
		super(message, { cause: options.cause });
		this.name = `Agent${code[0].toUpperCase()}${code.slice(1)}Error`;
		this.code = code;
		this.provider = options.provider;
		this.retryable = options.retryable ?? code === "transport";
		this.details = options.details;
	}
}

export class AgentTimeoutError extends AgentError {
	constructor(message = "agent call exceeded its deadline", details?: Record<string, unknown>) {
		super("timeout", message, { retryable: false, details });
		this.name = "AgentTimeoutError";
	}
}

export class AgentAbortError extends AgentError {
	constructor(message = "agent call was aborted", details?: Record<string, unknown>) {
		super("aborted", message, { retryable: false, details });
		this.name = "AgentAbortError";
	}
}

export class AgentPermissionError extends AgentError {
	constructor(message: string, details?: Record<string, unknown>) {
		super("permission", message, { retryable: false, details });
		this.name = "AgentPermissionError";
	}
}

export class AgentStructuredOutputError extends AgentError {
	constructor(message: string, details?: Record<string, unknown>) {
		super("structured_output", message, { retryable: true, details });
		this.name = "AgentStructuredOutputError";
	}
}

export class AgentTransportError extends AgentError {
	constructor(message: string, options: { provider?: HarnessName; cause?: unknown; details?: Record<string, unknown> } = {}) {
		super("transport", message, { ...options, retryable: true });
		this.name = "AgentTransportError";
	}
}

export class AgentUnavailableError extends AgentError {
	constructor(message: string, details?: Record<string, unknown>) {
		super("unavailable", message, { retryable: false, details });
		this.name = "AgentUnavailableError";
	}
}

export interface AgentHarness {
	run<T = unknown>(request: AgentRequest): Promise<AgentResult<T>>;
	close?(): Promise<void>;
}

export function isAgentError(error: unknown): error is AgentError {
	return error instanceof AgentError;
}

export function errorCode(error: unknown): AgentErrorCode | "unknown" {
	return isAgentError(error) ? error.code : "unknown";
}
