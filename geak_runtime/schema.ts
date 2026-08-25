import { createHash } from "node:crypto";
import { AgentStructuredOutputError } from "./types";

export interface SchemaIssue {
	path: string;
	message: string;
}

type JsonSchema = Record<string, any>;

function typeMatches(value: unknown, type: string): boolean {
	switch (type) {
		case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
		case "array": return Array.isArray(value);
		case "string": return typeof value === "string";
		case "number": return typeof value === "number" && Number.isFinite(value);
		case "integer": return typeof value === "number" && Number.isInteger(value);
		case "boolean": return typeof value === "boolean";
		case "null": return value === null;
		default: return true;
	}
}

function joinPath(base: string, key: string | number): string {
	return typeof key === "number" ? `${base}[${key}]` : `${base}.${key}`;
}

/** Small JSON-Schema validator for the subset used by GEAK role contracts. */
export function validateJsonSchema(value: unknown, schema: unknown, basePath = "$", issues: SchemaIssue[] = []): SchemaIssue[] {
	if (!schema || typeof schema !== "object") return issues;
	const s = schema as JsonSchema;
	if (Array.isArray(s.anyOf)) {
		const alternatives = s.anyOf.map((candidate: unknown) => validateJsonSchema(value, candidate, basePath, []));
		if (!alternatives.some(candidate => candidate.length === 0)) issues.push({ path: basePath, message: "does not match any allowed schema" });
		return issues;
	}
	if (Array.isArray(s.oneOf)) {
		const matches = s.oneOf.filter((candidate: unknown) => validateJsonSchema(value, candidate, basePath, []).length === 0);
		if (matches.length !== 1) issues.push({ path: basePath, message: `matches ${matches.length} oneOf schemas, expected exactly one` });
		return issues;
	}
	if (s.type !== undefined) {
		const types = Array.isArray(s.type) ? s.type : [s.type];
		if (!types.some((type: string) => typeMatches(value, type))) {
			issues.push({ path: basePath, message: `expected ${types.join(" or ")}` });
			return issues;
		}
	}
	if (s.enum && Array.isArray(s.enum) && !s.enum.some((candidate: unknown) => Object.is(candidate, value))) {
		issues.push({ path: basePath, message: "is not an allowed enum value" });
	}
	if (s.const !== undefined && !Object.is(s.const, value)) issues.push({ path: basePath, message: "does not equal const" });
	if (typeof value === "string") {
		if (typeof s.minLength === "number" && value.length < s.minLength) issues.push({ path: basePath, message: `must contain at least ${s.minLength} characters` });
		if (typeof s.maxLength === "number" && value.length > s.maxLength) issues.push({ path: basePath, message: `must contain at most ${s.maxLength} characters` });
		if (typeof s.pattern === "string" && !new RegExp(s.pattern).test(value)) issues.push({ path: basePath, message: "does not match pattern" });
	}
	if (typeof value === "number") {
		if (typeof s.minimum === "number" && value < s.minimum) issues.push({ path: basePath, message: `must be >= ${s.minimum}` });
		if (typeof s.maximum === "number" && value > s.maximum) issues.push({ path: basePath, message: `must be <= ${s.maximum}` });
	}
	if (Array.isArray(value)) {
		if (typeof s.minItems === "number" && value.length < s.minItems) issues.push({ path: basePath, message: `must contain at least ${s.minItems} items` });
		if (typeof s.maxItems === "number" && value.length > s.maxItems) issues.push({ path: basePath, message: `must contain at most ${s.maxItems} items` });
		if (s.items) value.forEach((item, index) => validateJsonSchema(item, s.items, joinPath(basePath, index), issues));
	}
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		const objectValue = value as Record<string, unknown>;
		const required = Array.isArray(s.required) ? s.required : [];
		for (const key of required) if (!Object.prototype.hasOwnProperty.call(objectValue, key)) issues.push({ path: joinPath(basePath, key), message: "is required" });
		const properties = s.properties && typeof s.properties === "object" ? s.properties as Record<string, unknown> : {};
		for (const [key, child] of Object.entries(properties)) if (Object.prototype.hasOwnProperty.call(objectValue, key)) validateJsonSchema(objectValue[key], child, joinPath(basePath, key), issues);
		if (s.additionalProperties === false) for (const key of Object.keys(objectValue)) if (!Object.prototype.hasOwnProperty.call(properties, key)) issues.push({ path: joinPath(basePath, key), message: "additional property is not allowed" });
		if (s.additionalProperties && typeof s.additionalProperties === "object") for (const key of Object.keys(objectValue)) if (!Object.prototype.hasOwnProperty.call(properties, key)) validateJsonSchema(objectValue[key], s.additionalProperties, joinPath(basePath, key), issues);
	}
	return issues;
}

export function schemaHash(schema: unknown): string {
	const canonicalize = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(canonicalize);
		if (value && typeof value === "object") {
			return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(key => [key, canonicalize((value as Record<string, unknown>)[key])]));
		}
		return value;
	};
	return createHash("sha256").update(JSON.stringify(canonicalize(schema))).digest("hex").slice(0, 16);
}

function parseJson(text: string): unknown | undefined {
	try { return JSON.parse(text); } catch { return undefined; }
}

/** Extract JSON objects/arrays from provider text without trusting prose. */
export function jsonCandidates(raw: string): unknown[] {
	const text = String(raw ?? "").trim();
	const candidates: unknown[] = [];
	const add = (value: unknown) => {
		if (value === undefined) return;
		const encoded = JSON.stringify(value);
		if (!candidates.some(existing => JSON.stringify(existing) === encoded)) candidates.push(value);
	};
	add(parseJson(text));
	for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)) add(parseJson(match[1]));
	let start = -1;
	let depth = 0;
	let quote = false;
	let escaped = false;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (quote) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') quote = false;
			continue;
		}
		if (char === '"') { quote = true; continue; }
		if (char === "{" || char === "[") { if (depth === 0) start = index; depth += 1; }
		if (char === "}" || char === "]") {
			if (depth === 0) continue;
			depth -= 1;
			if (depth === 0 && start >= 0) add(parseJson(text.slice(start, index + 1)));
		}
	}
	return candidates;
}

export function parseStructuredOutput<T>(raw: string, schema: unknown, strict = true): T {
	for (const candidate of jsonCandidates(raw)) {
		const values = [candidate];
		if (candidate && typeof candidate === "object") {
			const record = candidate as Record<string, unknown>;
			if (Object.prototype.hasOwnProperty.call(record, "data")) values.unshift(record.data);
			if (record.result && typeof record.result === "object" && Object.prototype.hasOwnProperty.call(record.result, "data")) values.unshift((record.result as Record<string, unknown>).data);
		}
		for (const value of values) {
			const issues = validateJsonSchema(value, schema);
			if (!issues.length) return value as T;
		}
	}
	const first = jsonCandidates(raw)[0];
	const issues = first === undefined ? [{ path: "$", message: "response was not valid JSON" }] : validateJsonSchema(first, schema);
	if (!strict && first !== undefined) return first as T;
	throw new AgentStructuredOutputError(`structured output failed schema validation: ${issues.slice(0, 4).map(issue => `${issue.path} ${issue.message}`).join("; ")}`, { raw: String(raw).slice(-4_000), schemaHash: schemaHash(schema) });
}
