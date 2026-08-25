import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { fetchUrl } from "../../geak_runtime/web_fetch.ts";

function isInside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function parseInvocation(raw: string): { workflow: string; args: Record<string, unknown> } {
	const trimmed = raw.trim();
	if (!trimmed) throw new Error("usage: /geak <workflow.js> [JSON workflow args]");
	const split = trimmed.search(/\s/);
	const workflow = split < 0 ? trimmed : trimmed.slice(0, split);
	const argsText = split < 0 ? "{}" : trimmed.slice(split).trim() || "{}";
	const parsed = JSON.parse(argsText);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("workflow args must be a JSON object");
	return { workflow, args: parsed };
}

function lastJson(text: string): Record<string, unknown> | undefined {
	for (const line of text.trim().split(/\r?\n/).reverse()) {
		try {
			const value = JSON.parse(line);
			if (value && typeof value === "object" && !Array.isArray(value)) return value;
		} catch { /* runner diagnostics may surround the final JSON */ }
	}
	return undefined;
}

export default function geakExtension(pi: ExtensionAPI) {
	const z = pi.zod;
	const repositoryRoot = path.resolve(import.meta.dir, "../..");
	const runner = path.join(repositoryRoot, "geak_runtime", "omp_runner.ts");

	pi.setLabel("GEAK");
	pi.registerTool({
		name: "web_fetch",
		label: "GEAK web fetch",
		description: "Fetch a known HTTP(S) URL with GEAK timeout and size limits. Use web_search for discovery.",
		parameters: z.object({ url: z.string().describe("Known HTTP(S) URL") }),
		approval: "read",
		async execute(_id, params, signal) {
			if (signal?.aborted) return { content: [{ type: "text", text: "web_fetch cancelled" }], isError: true };
			try {
				const result = await fetchUrl(params.url);
				return { content: [{ type: "text", text: result.text }], details: { url: result.url, status: result.status, contentType: result.contentType } };
			} catch (error) {
				return { content: [{ type: "text", text: String(error) }], isError: true };
			}
		},
	});

	pi.registerCommand("geak", {
		description: "Run a GEAK workflow through the shared OMP runner",
		handler: async (rawArgs, ctx) => {
			try {
				const parsed = parseInvocation(rawArgs);
				const workflowScript = path.resolve(ctx.cwd, parsed.workflow);
				if (path.extname(workflowScript) !== ".js" || !isInside(repositoryRoot, workflowScript)) {
					throw new Error(`workflow must be a .js file inside ${repositoryRoot}`);
				}
				const invocation = {
					schema_version: 1,
					harness: "omp",
					repository_root: repositoryRoot,
					workspace: ctx.cwd,
					workflow_script: workflowScript,
					workflow_args: parsed.args,
					allowed_tools: (process.env.GEAK_OMP_ALLOWED_TOOLS || "bash,read,write,edit,grep,glob,web_search,web_fetch").split(",").map(item => item.trim()).filter(Boolean),
					run_id: `omp-${Date.now()}`,
				};
				const invocationPath = path.join("/tmp", `geak-omp-${process.pid}-${Date.now()}.json`);
				await Bun.write(invocationPath, JSON.stringify(invocation));
				try {
					ctx.ui.notify(`GEAK starting ${path.relative(repositoryRoot, workflowScript)}`, "info");
					const result = await pi.exec("bun", [runner, "--invocation", invocationPath], { cwd: repositoryRoot });
					if (result.code !== 0) {
						ctx.ui.notify(`GEAK failed: ${(result.stderr || result.stdout || "runner error").trim().slice(-1000)}`, "error");
						return;
					}
					const output = lastJson(result.stdout);
					ctx.ui.notify(`GEAK complete${output?.eval_dir ? `: ${output.eval_dir}` : ""}`, "info");
				} finally {
					try { await unlink(invocationPath); } catch { /* best effort */ }
				}
			} catch (error) {
				ctx.ui.notify(`GEAK usage/error: ${String(error)}`, "error");
			}
		},
	});
}
