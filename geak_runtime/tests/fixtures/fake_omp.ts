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
