export const SessionManager = {
	inMemory: (_cwd?: string) => ({}),
};

export let lastOptions: Record<string, any> | undefined;

export async function createAgentSession(options: Record<string, any>) {
	lastOptions = options;
	const slow = options.modelPattern === "slow";
	const session: any = {
		messages: options.outputSchema ? [{ toolName: "yield", details: { data: { answer: "structured" } } }] : [],
		subscribe: () => () => {},
		prompt: async () => {
			if (slow) await new Promise(resolve => setTimeout(resolve, 50));
		},
		getLastAssistantText: () => "free form",
		abort: async () => {},
		dispose: async () => {},
	};
	return { session };
}

export const catalogCalls: Array<{ cwd: string; options: Record<string, unknown> }> = [];
export const closedAuthStorages: unknown[] = [];

export const Settings = {
	init: async (options: { cwd?: string }) => ({ kind: "fake-settings", cwd: options.cwd }),
};

export class ModelRegistry {
	constructor(
		readonly authStorage: unknown,
		readonly modelsPath?: string,
		readonly options?: { settings?: unknown },
	) {}
}

export async function discoverAuthStorage() {
	const storage = { close: () => closedAuthStorages.push(storage) };
	return storage;
}

export async function loadCliExtensionProviders(
	modelRegistry: unknown,
	settings: unknown,
	cwd: string,
	options: Record<string, unknown> = {},
) {
	catalogCalls.push({ cwd, options: { ...options, modelRegistry, settings } });
}
