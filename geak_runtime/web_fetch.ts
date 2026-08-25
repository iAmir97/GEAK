import { AgentPermissionError, AgentTransportError } from "./types";

export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
export const DEFAULT_FETCH_MAX_BYTES = 2 * 1024 * 1024;

export interface WebFetchOptions {
	timeoutMs?: number;
	maxBytes?: number;
}

export interface WebFetchResult {
	url: string;
	status: number;
	contentType: string;
	text: string;
	truncated: boolean;
}

export function validateFetchUrl(raw: string): URL {
	let url: URL;
	try { url = new URL(raw); } catch { throw new AgentPermissionError(`web_fetch requires a valid URL: ${raw}`); }
	if (!new Set(["http:", "https:"]).has(url.protocol)) throw new AgentPermissionError(`web_fetch only permits http(s) URLs: ${url.protocol}`);
	if (url.username || url.password) throw new AgentPermissionError("web_fetch refuses URLs containing embedded credentials");
	return url;
}

export async function fetchUrl(raw: string, options: WebFetchOptions = {}): Promise<WebFetchResult> {
	const url = validateFetchUrl(raw);
	const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
	const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_FETCH_MAX_BYTES);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort("web_fetch timeout"), timeoutMs);
	try {
		const response = await fetch(url, { signal: controller.signal, redirect: "follow" });
		const contentType = response.headers.get("content-type") || "application/octet-stream";
		if (!response.ok) throw new AgentTransportError(`web_fetch received HTTP ${response.status} from ${url}`, { details: { status: response.status, url: String(url) } });
		const declaredLength = Number(response.headers.get("content-length") || 0);
		if (declaredLength > maxBytes) throw new AgentPermissionError(`web_fetch response exceeds ${maxBytes} bytes`, { url: String(url), contentLength: declaredLength });
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength > maxBytes) throw new AgentPermissionError(`web_fetch response exceeds ${maxBytes} bytes`, { url: String(url), contentLength: bytes.byteLength });
		const text = new TextDecoder().decode(bytes);
		return { url: String(response.url || url), status: response.status, contentType, text, truncated: false };
	} catch (error) {
		if (error instanceof AgentPermissionError || error instanceof AgentTransportError) throw error;
		if (controller.signal.aborted) throw new AgentTransportError(`web_fetch timed out after ${timeoutMs}ms: ${url}`, { details: { url: String(url), timeoutMs }, cause: error });
		throw new AgentTransportError(`web_fetch failed for ${url}: ${String(error)}`, { details: { url: String(url) }, cause: error });
	} finally {
		clearTimeout(timer);
	}
}

export function createWebFetchTool(): Record<string, unknown> {
	return {
		name: "web_fetch",
		label: "GEAK web fetch",
		description: "Fetch a known HTTP(S) URL with GEAK size and timeout limits. Use web_search for discovery.",
		parameters: {
			type: "object",
			properties: { url: { type: "string", description: "Known HTTP(S) URL to retrieve" } },
			required: ["url"],
			additionalProperties: false,
		},
		approval: "read",
		async execute(_id: string, params: { url: string }, signal?: AbortSignal) {
			if (signal?.aborted) return { content: [{ type: "text", text: "web_fetch cancelled" }], isError: true };
			try {
				const result = await fetchUrl(params.url);
				return { content: [{ type: "text", text: result.text }], details: { url: result.url, status: result.status, contentType: result.contentType } };
			} catch (error) {
				return { content: [{ type: "text", text: String(error) }], isError: true, details: { error: String(error) } };
			}
		},
	};
}
