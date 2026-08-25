import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalToolName, resolveHarnessConfig, type HarnessConfig } from "./config";
import { parseStructuredOutput, schemaHash } from "./schema";
import {
	AgentAbortError,
	AgentPermissionError,
	AgentStructuredOutputError,
	AgentTimeoutError,
	AgentTransportError,
	AgentUnavailableError,
	type AgentHarness,
	type AgentRequest,
	type AgentResult,
} from "./types";
import { createWebFetchTool } from "./web_fetch";

type OmpModule = Record<string, any>;
export interface OmpRuntime {
	module: OmpModule;
	entry?: string;
}

function elapsed(start: number): number { return Math.max(0, performance.now() - start); }

async function disposeWithGrace(session: any, graceMs: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			Promise.resolve(session.dispose?.()),
			new Promise(resolve => { timer = setTimeout(resolve, Math.max(0, graceMs)); }),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function moduleFromPath(candidate: string): Promise<OmpModule | undefined> {
	try {
		const imported = await import(pathToFileURL(candidate).href);
		return (imported.default && typeof imported.default === "object" ? { ...imported.default, ...imported } : imported) as OmpModule;
	} catch {
		return undefined;
	}
}

async function locateGlobalOmp(command: string): Promise<string | undefined> {
	const executable = typeof Bun !== "undefined" ? Bun.which(command) : undefined;
	if (!executable) return undefined;
	try {
		const resolved = await realpath(executable);
		const packageRoot = path.resolve(path.dirname(resolved), "..");
		for (const candidate of [path.join(packageRoot, "src", "index.ts"), path.join(packageRoot, "dist", "index.js")]) {
			if (existsSync(candidate)) return candidate;
		}
	} catch { /* fall through to normal import */ }
	return undefined;
}

async function packageVersionFromEntry(entry: string | undefined): Promise<string | undefined> {
	if (!entry) return undefined;
	let directory = path.dirname(path.resolve(entry));
	for (let depth = 0; depth < 6; depth += 1) {
		const packageFile = path.join(directory, "package.json");
		if (existsSync(packageFile)) {
			try {
				const parsed = JSON.parse(await readFile(packageFile, "utf8"));
				if (parsed?.name === "@oh-my-pi/pi-coding-agent") return typeof parsed.version === "string" ? parsed.version : undefined;
			} catch { /* keep walking; a broken unrelated package.json is not OMP */ }
		}
		const parent = path.dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	return undefined;
}

export async function detectOmpVersion(config: HarnessConfig): Promise<string | undefined> {
	const entries = [
		config.ompModule ? path.resolve(config.ompModule) : undefined,
		path.join(import.meta.dir, "node_modules", "@oh-my-pi", "pi-coding-agent", "src", "index.ts"),
		await locateGlobalOmp(config.ompCommand),
	];
	for (const entry of entries) {
		const version = await packageVersionFromEntry(entry);
		if (version) return version;
	}
	return undefined;
}

async function loadOmp(config: HarnessConfig): Promise<OmpRuntime> {
	if (config.ompModule) {
		const entry = path.resolve(config.ompModule);
		const explicit = await moduleFromPath(entry);
		if (explicit) return { module: explicit, entry };
		throw new AgentUnavailableError(`OMP module could not be loaded from GEAK_OMP_MODULE=${config.ompModule}`);
	}
	try {
		return { module: await import("@oh-my-pi/pi-coding-agent") as OmpModule };
	} catch (error) {
		const globalEntry = await locateGlobalOmp(config.ompCommand);
		if (globalEntry) {
			const globalModule = await moduleFromPath(globalEntry);
			if (globalModule) return { module: globalModule, entry: globalEntry };
		}
		throw new AgentUnavailableError(`OMP SDK is not installed. Install geak_runtime dependencies with Bun (expected @oh-my-pi/pi-coding-agent ${config.ompVersion}) or set GEAK_OMP_MODULE. ${String(error)}`);
	}
}

function textFromMessage(message: any): string {
	if (!message) return "";
	if (typeof message === "string") return message;
	if (typeof message.text === "string") return message.text;
	if (Array.isArray(message.content)) return message.content.filter((item: any) => item?.type === "text").map((item: any) => item.text).join("");
	return "";
}

function structuredFromMessages(messages: any[]): unknown | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		const isYield = message?.toolName === "yield" || message?.name === "yield" || message?.toolCall?.name === "yield";
		if (!isYield) continue;
		const details = message.details ?? message.result?.details;
		if (details && Object.prototype.hasOwnProperty.call(details, "data")) return details.data;
		const candidate = message.result?.data ?? message.data;
		if (candidate !== undefined) return candidate;
	}
	return undefined;
}

function normalizeOmpError(error: unknown, request: AgentRequest): never {
	if (error instanceof AgentAbortError || error instanceof AgentTimeoutError || error instanceof AgentPermissionError || error instanceof AgentStructuredOutputError || error instanceof AgentTransportError || error instanceof AgentUnavailableError) throw error;
	const message = String(error instanceof Error ? error.message : error);
	if (/abort|cancel/i.test(message)) throw new AgentAbortError(message);
	if (/permission|approval|tool.*not|not allowed|denied/i.test(message)) throw new AgentPermissionError(message, { tools: request.tools });
	throw new AgentTransportError(message, { provider: "omp", cause: error });
}

export class OmpHarness implements AgentHarness {
	private readonly config: HarnessConfig;
	private readonly runtimePromise: Promise<OmpRuntime>;
	private readonly sessions = new Set<any>();

	constructor(config = resolveHarnessConfig(process.cwd(), "omp")) {
		this.config = config;
		this.runtimePromise = loadOmp(config);
	}

	/** Resolve the SDK once for diagnostics and for the first agent call. */
	async ready(): Promise<OmpRuntime> {
		return this.runtimePromise;
	}

	async run<T = unknown>(request: AgentRequest): Promise<AgentResult<T>> {
		const start = performance.now();
		if (request.signal?.aborted) throw new AgentAbortError("OMP agent call was aborted before session creation");
		const runtime = await this.runtimePromise.catch(error => normalizeOmpError(error, request));
		const module = runtime.module;
		const allowed = new Set(this.config.ompAllowedTools.map(canonicalToolName));
		const requested = (request.tools?.length ? request.tools : this.config.ompAllowedTools).map(canonicalToolName);
		const disallowed = requested.filter(tool => !allowed.has(tool));
		if (disallowed.length) throw new AgentPermissionError(`OMP tool request is outside the GEAK allowlist: ${disallowed.join(", ")}`, { requested, allowed: [...allowed] });
		const toolNames = [...new Set(requested.filter(tool => tool !== "web_fetch"))];
		if (requested.includes("web_fetch")) toolNames.push("web_fetch");
		let session: any;
		let unsubscribe: (() => void) | undefined;
		const sessionStart = performance.now();
		try {
			const extensionPaths = this.config.ompExtensionPaths.map(extensionPath => path.resolve(extensionPath));
			const options: Record<string, any> = {
				cwd: request.cwd,
				sessionManager: module.SessionManager.inMemory(request.cwd),
				toolNames,
				restrictToolNames: true,
				enableMCP: this.config.ompEnableMcp,
				enableLsp: this.config.ompEnableLsp,
				autoApprove: true,
				// Keep GEAK sessions isolated by default. Custom OMP providers
				// (for example TokenVisor) are commonly registered by an
				// installed extension rather than models.yml, so allow callers
				// to opt into ambient discovery or provide an exact extension
				// path without changing the default tool policy.
				disableExtensionDiscovery: !this.config.ompEnableExtensions && extensionPaths.length === 0,
				additionalExtensionPaths: extensionPaths,
			};
			if (request.outputSchema !== undefined) {
				options.outputSchema = request.outputSchema;
				options.outputSchemaMode = request.outputSchemaMode === "strict" ? "strict" : "permissive";
				options.requireYieldTool = true;
			}
			if (request.model || this.config.ompModel) options.modelPattern = request.model || this.config.ompModel;
			if (request.thinking || this.config.ompThinking) options.thinkingLevel = request.thinking || this.config.ompThinking;
			if (requested.includes("web_fetch")) {
				options.customTools = [createWebFetchTool()];
				options.allowRestrictedCustomTools = true;
			}
			const created = await module.createAgentSession(options);
			session = created.session;
			this.sessions.add(session);
			const textChunks: string[] = [];
			const toolStarts = new Map<string, number>();
			let toolExecutionMs = 0;
			let firstTokenAt: number | undefined;
			unsubscribe = session.subscribe?.((event: any) => {
				if (event?.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
					if (firstTokenAt === undefined) firstTokenAt = performance.now();
					textChunks.push(event.assistantMessageEvent.delta);
				}
				if (event?.type === "tool_execution_start") toolStarts.set(String(event.toolCallId || event.toolName || toolStarts.size), performance.now());
				if (event?.type === "tool_execution_end") {
					const key = String(event.toolCallId || event.toolName || "");
					const started = toolStarts.get(key);
					if (started !== undefined) toolExecutionMs += elapsed(started);
					toolStarts.delete(key);
				}
			});
			const onAbort = () => { try { void session.abort?.(); } catch { /* cleanup below */ } };
			request.signal?.addEventListener("abort", onAbort, { once: true });
			const promptStart = performance.now();
			const promptPromise = session.prompt(request.prompt);
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeoutPromise = request.timeoutMs && request.timeoutMs > 0
				? new Promise<never>((_, reject) => { timer = setTimeout(() => { try { void session.abort?.(); } catch {} reject(new AgentTimeoutError(`OMP agent call exceeded ${request.timeoutMs}ms`)); }, request.timeoutMs); })
				: undefined;
			try {
				if (timeoutPromise) await Promise.race([promptPromise, timeoutPromise]);
				else await promptPromise;
			} finally {
				if (timer) clearTimeout(timer);
				request.signal?.removeEventListener("abort", onAbort);
			}
			if (request.signal?.aborted) throw new AgentAbortError("OMP agent call was aborted");
			const rawText = String(session.getLastAssistantText?.() || textChunks.join(""));
			const schemaStart = performance.now();
			const structured = request.outputSchema !== undefined ? structuredFromMessages(session.messages ?? []) : undefined;
			const data = request.outputSchema !== undefined
				? structured !== undefined ? structured as T : parseStructuredOutput<T>(rawText, request.outputSchema, request.outputSchemaMode !== "loose")
				: undefined;
			if (request.outputSchema !== undefined && structured !== undefined) {
				// OMP performs its own schema enforcement, but validate again at the
				// provider boundary so workflow code sees one stable contract.
				parseStructuredOutput(JSON.stringify(structured), request.outputSchema, request.outputSchemaMode !== "loose");
			}
			const timingsMs: Record<string, number> = {
				sessionCreation: elapsed(sessionStart),
				modelCompletion: elapsed(promptStart),
				toolExecution: toolExecutionMs,
				schemaValidation: request.outputSchema === undefined ? 0 : elapsed(schemaStart),
				total: elapsed(start),
			};
			if (firstTokenAt !== undefined) timingsMs.modelTimeToFirstToken = Math.max(0, firstTokenAt - promptStart);
			if (process.env.GEAK_DEBUG_TIMINGS === "1") process.stderr.write(`[geak omp timings] ${JSON.stringify(timingsMs)}\n`);
			return {
				data,
				text: rawText || undefined,
				provider: "omp",
				diagnostics: {
					schemaHash: request.outputSchema === undefined ? undefined : schemaHash(request.outputSchema),
					model: request.model || this.config.ompModel,
					timingsMs,
					rawText: process.env.GEAK_DEBUG_TRANSCRIPTS === "1" ? rawText.slice(-4_000) : undefined,
				},
			};
		} catch (error) {
			normalizeOmpError(error, request);
		} finally {
			unsubscribe?.();
			if (session) {
				this.sessions.delete(session);
				try { session.beginDispose?.(); } catch {}
				try { await disposeWithGrace(session, this.config.ompTimeoutGraceMs); } catch {}
			}
		}
	}

	async close(): Promise<void> {
		for (const session of [...this.sessions]) {
			try { session.beginDispose?.(); } catch {}
			try { await disposeWithGrace(session, this.config.ompTimeoutGraceMs); } catch {}
		}
		this.sessions.clear();
	}
}
