import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { HarnessName } from "./types";

export const DEFAULT_OMP_VERSION = "17.4.0";
export const DEFAULT_OMP_ALLOWED_TOOLS = [
	"bash",
	"read",
	"write",
	"edit",
	"grep",
	"glob",
	"web_search",
	"web_fetch",
];

export interface HarnessConfig {
	harness: HarnessName;
	source: "explicit" | "environment" | "repository" | "default";
	ompCommand: string;
	ompModule?: string;
	ompModel?: string;
	ompThinking?: string;
	ompAllowedTools: string[];
	ompEnableMcp: boolean;
	ompEnableLsp: boolean;
	ompVersion: string;
	ompTimeoutGraceMs: number;
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return fallback;
	if (["1", "true", "yes", "on"].includes(value.trim().toLowerCase())) return true;
	if (["0", "false", "no", "off"].includes(value.trim().toLowerCase())) return false;
	return fallback;
}

function csv(value: unknown, fallback: string[]): string[] {
	if (typeof value !== "string") return [...fallback];
	const values = value.split(",").map(item => item.trim()).filter(Boolean);
	return values.length ? [...new Set(values)] : [...fallback];
}

function readRepositoryConfig(repoRoot: string): Record<string, unknown> {
	for (const candidate of [
		path.join(repoRoot, ".geak", "config.json"),
		path.join(repoRoot, "geak.config.json"),
	]) {
		if (!existsSync(candidate)) continue;
		try {
			const parsed = JSON.parse(readFileSync(candidate, "utf8"));
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
		} catch (error) {
			throw new Error(`invalid GEAK harness configuration at ${candidate}: ${String(error)}`);
		}
	}
	return {};
}

function validHarness(value: unknown): HarnessName | undefined {
	const normalized = String(value ?? "").trim().toLowerCase();
	return normalized === "claude" || normalized === "omp" ? normalized : undefined;
}

/**
 * Resolve harness configuration with the documented precedence:
 * explicit argument, environment, repository config, then Claude.
 */
export function resolveHarnessConfig(repoRoot: string, explicit?: string): HarnessConfig {
	const repository = readRepositoryConfig(repoRoot);
	const omp = repository.omp && typeof repository.omp === "object" ? repository.omp as Record<string, unknown> : {};
	const explicitHarness = validHarness(explicit);
	const environmentHarness = validHarness(process.env.GEAK_AGENT_HARNESS);
	const repositoryHarness = validHarness(repository.agent_harness ?? repository.harness);
	const harness = explicitHarness ?? environmentHarness ?? repositoryHarness ?? "claude";
	const source = explicitHarness ? "explicit" : environmentHarness ? "environment" : repositoryHarness ? "repository" : "default";
	const env = process.env;
	const stringSetting = (envName: string, key: string, fallback?: unknown): string | undefined => {
		const envValue = env[envName];
		if (envValue !== undefined && envValue.trim() !== "") return envValue.trim();
		const value = omp[key] ?? fallback;
		return typeof value === "string" && value.trim() ? value.trim() : undefined;
	};
	const numericSetting = (envName: string, key: string, fallback: number): number => {
		const raw = env[envName] ?? omp[key] ?? fallback;
		const value = Number(raw);
		return Number.isFinite(value) && value >= 0 ? value : fallback;
	};

	return {
		harness,
		source,
		ompCommand: stringSetting("GEAK_OMP_COMMAND", "command", "omp") ?? "omp",
		ompModule: stringSetting("GEAK_OMP_MODULE", "module"),
		ompModel: stringSetting("GEAK_OMP_MODEL", "model"),
		ompThinking: stringSetting("GEAK_OMP_THINKING", "thinking"),
		ompAllowedTools: csv(env.GEAK_OMP_ALLOWED_TOOLS ?? omp.allowed_tools, DEFAULT_OMP_ALLOWED_TOOLS),
		ompEnableMcp: parseBoolean(env.GEAK_OMP_ENABLE_MCP ?? omp.enable_mcp, false),
		ompEnableLsp: parseBoolean(env.GEAK_OMP_ENABLE_LSP ?? omp.enable_lsp, false),
		ompVersion: stringSetting("GEAK_OMP_VERSION", "version", DEFAULT_OMP_VERSION) ?? DEFAULT_OMP_VERSION,
		ompTimeoutGraceMs: numericSetting("GEAK_OMP_TIMEOUT_GRACE_MS", "timeout_grace_ms", 5_000),
	};
}

export function canonicalToolName(name: string): string {
	const normalized = String(name).trim();
	const aliases: Record<string, string> = {
		Bash: "bash",
		Read: "read",
		Write: "write",
		Edit: "edit",
		Grep: "grep",
		Glob: "glob",
		WebSearch: "web_search",
		WebFetch: "web_fetch",
		shell: "bash",
		search: "grep",
		fetch: "web_fetch",
	};
	return aliases[normalized] ?? normalized.toLowerCase();
}
